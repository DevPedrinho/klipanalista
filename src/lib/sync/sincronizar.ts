/**
 * Sincronização KlipFlowi → Supabase, em rodadas curtas (cabem nos 60s da Vercel Hobby).
 *
 * Fases: atendentes → conversas → mensagens → contatos → fim.
 * O estado (fase + cursor + estatísticas) fica em klip.sync_runs; cada chamada
 * continua de onde a anterior parou.
 */
import type { KlipflowiApi } from "../klipflowi/api";
import { KlipflowiError } from "../klipflowi/client";
import {
  dentroDaJanela,
  mapAgent,
  mapContact,
  mapMessage,
  mapSession,
  resumirMensagens,
  type AgentRow,
  type ContactRow,
  type MessageRow,
  type ResumoMensagens,
  type SessionRow,
} from "../klipflowi/mappers";

export type Fase = "atendentes" | "conversas" | "mensagens" | "contatos" | "fim";

export interface Estatisticas {
  atendentes: number;
  paginasLidas: number;
  conversas: number;
  conversasComMensagens: number;
  mensagens: number;
  audios: number;
  audiosSemTranscricao: number;
  contatos: number;
  erros: number;
  ultimoErro?: string;
}

export interface EstadoSync {
  fase: Fase;
  cursor: { pagina?: number; contatosFalhos?: string[] };
  stats: Estatisticas;
}

export const estadoInicial = (): EstadoSync => ({
  fase: "atendentes",
  cursor: {},
  stats: {
    atendentes: 0,
    paginasLidas: 0,
    conversas: 0,
    conversasComMensagens: 0,
    mensagens: 0,
    audios: 0,
    audiosSemTranscricao: 0,
    contatos: 0,
    erros: 0,
  },
});

/** Operações de banco que a sincronização usa (implementadas em repo.ts). */
export interface RepoSync {
  salvarAtendentes(rows: AgentRow[]): Promise<void>;
  estadoDasConversas(ids: string[]): Promise<Map<string, { last_interaction_at: string | null; needs_message_sync: boolean }>>;
  salvarConversas(rows: (SessionRow & { needs_message_sync: boolean })[]): Promise<void>;
  /** Conversas que precisam de mensagens e ainda não foram tentadas nesta rodada de sync. */
  conversasPendentes(limite: number, tentadasAntesDe: string): Promise<string[]>;
  salvarMensagens(sessionId: string, rows: MessageRow[], resumo: ResumoMensagens): Promise<void>;
  marcarErroMensagens(sessionId: string, erro: string): Promise<void>;
  contatosFaltando(limite: number, ignorar: string[]): Promise<string[]>;
  salvarContatos(rows: ContactRow[]): Promise<void>;
}

export interface OpcoesRodada {
  corte: Date;
  /** Início da sincronização (não da rodada): evita repetir a mesma conversa. */
  inicioDaSync: string;
  orcamentoMs: number;
  concorrencia?: number;
  agora?: () => number;
}

export async function executarRodada(
  estadoAtual: EstadoSync,
  api: KlipflowiApi,
  repo: RepoSync,
  opcoes: OpcoesRodada,
): Promise<EstadoSync> {
  const agora = opcoes.agora ?? Date.now;
  const inicio = agora();
  const temTempo = () => agora() - inicio < opcoes.orcamentoMs;
  const concorrencia = opcoes.concorrencia ?? 6;

  const estado: EstadoSync = structuredClone(estadoAtual);
  const { stats } = estado;

  const registrarErro = (e: unknown) => {
    stats.erros++;
    stats.ultimoErro = e instanceof Error ? e.message : String(e);
  };

  while (estado.fase !== "fim" && temTempo()) {
    switch (estado.fase) {
      case "atendentes": {
        const rows = (await api.listarAtendentes()).map(mapAgent).filter((r): r is AgentRow => r !== null);
        await repo.salvarAtendentes(rows);
        stats.atendentes = rows.length;
        estado.fase = "conversas";
        break;
      }

      case "conversas": {
        // A API lista da mais antiga para a mais nova e não filtra por data:
        // começamos na última página e voltamos até uma página inteira ficar fora da janela.
        if (estado.cursor.pagina === undefined) {
          const primeira = await api.paginaDeConversas(1);
          estado.cursor.pagina = Math.max(primeira.totalPages, 1);
        }
        while (temTempo() && estado.cursor.pagina !== undefined) {
          const pagina = await api.paginaDeConversas(estado.cursor.pagina);
          stats.paginasLidas++;
          const recentes = pagina.items.filter((item) => dentroDaJanela(item, opcoes.corte));
          await salvarConversas(recentes, repo);
          stats.conversas += recentes.length;

          const acabou = (pagina.items.length > 0 && recentes.length === 0) || estado.cursor.pagina <= 1;
          if (acabou) {
            estado.cursor.pagina = undefined;
            estado.fase = "mensagens";
          } else {
            estado.cursor.pagina--;
          }
        }
        break;
      }

      case "mensagens": {
        const ids = await repo.conversasPendentes(concorrencia * 3, opcoes.inicioDaSync);
        if (ids.length === 0) {
          estado.fase = "contatos";
          break;
        }
        for (let i = 0; i < ids.length && temTempo(); i += concorrencia) {
          await Promise.all(
            ids.slice(i, i + concorrencia).map(async (sessionId) => {
              try {
                const brutas = await api.listarMensagens(sessionId);
                const rows = brutas
                  .map((m) => mapMessage(m, sessionId))
                  .filter((m): m is MessageRow => m !== null);
                const resumo = resumirMensagens(rows);
                await repo.salvarMensagens(sessionId, rows, resumo);
                stats.conversasComMensagens++;
                stats.mensagens += resumo.message_count;
                stats.audios += resumo.audio_count;
                stats.audiosSemTranscricao += resumo.pending_transcriptions;
              } catch (e) {
                registrarErro(e);
                await repo.marcarErroMensagens(sessionId, e instanceof Error ? e.message : String(e));
              }
            }),
          );
        }
        break;
      }

      case "contatos": {
        const falhos = estado.cursor.contatosFalhos ?? [];
        const ids = await repo.contatosFaltando(concorrencia * 3, falhos);
        if (ids.length === 0) {
          estado.cursor.contatosFalhos = undefined;
          estado.fase = "fim";
          break;
        }
        const rows: ContactRow[] = [];
        await Promise.all(
          ids.map(async (id) => {
            try {
              const row = mapContact(await api.buscarContato(id));
              if (row) rows.push(row);
              else falhos.push(id);
            } catch (e) {
              if (e instanceof KlipflowiError && (e.status === 404 || e.status === 401)) {
                // Contato removido na KlipFlowi: grava um marcador para não buscar de novo.
                rows.push({ id, name: null, phone: null, email: null, tags: [], raw: { naoEncontrado: true } });
              } else {
                registrarErro(e);
                falhos.push(id);
              }
            }
          }),
        );
        await repo.salvarContatos(rows);
        stats.contatos += rows.length;
        estado.cursor.contatosFalhos = falhos;
        break;
      }
    }
  }

  return estado;
}

async function salvarConversas(itens: unknown[], repo: RepoSync) {
  const rows = itens.map(mapSession).filter((r): r is SessionRow => r !== null);
  if (rows.length === 0) return;
  const existentes = await repo.estadoDasConversas(rows.map((r) => r.id));
  await repo.salvarConversas(
    rows.map((row) => {
      const antes = existentes.get(row.id);
      const mudou = !antes || mesmoInstante(antes.last_interaction_at, row.last_interaction_at) === false;
      return { ...row, needs_message_sync: mudou || antes.needs_message_sync };
    }),
  );
}

/** O banco devolve `+00:00`, a API `Z`: compara o instante, não o texto. */
function mesmoInstante(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}
