import "server-only";
import type { ContactSnapshot, ConversationSnapshot } from "@/domain/types";
import { contactsAdapter, sessionsAdapter } from "@/server/integration/adapters";
import type { AdapterResult } from "@/server/integration/adapters/base";
import { ApiError, type ApiFailureKind } from "@/server/integration/http/client";
import { emParalelo, type SourceFailure } from "./intelligence.service";

/**
 * Busca de atendimentos pelo id, um punhado por vez.
 *
 * POR QUE PELO ID
 *
 * A listagem (`GET /v2/session`) so pagina de tras para frente, sem filtro
 * de data, e para no teto de paginas: um mes inteiro de uma conta nao cabe.
 * A busca direta (`GET /v2/session/{id}`) nao tem nenhum desses limites — e
 * traz o que a planilha nao tem: transcricao de audio, direcao e o contato
 * de verdade. O que faltava era saber os ids; a planilha exportada fornece.
 *
 * O QUE VOLTA ALEM DAS CONVERSAS
 *
 * Um veredito por id. A importacao de um mes leva minutos, em dezenas de
 * chamadas, e o navegador precisa saber exatamente o que refazer: o que
 * nao existe mais nao se tenta de novo; o que esbarrou em limite de
 * requisicoes ou no prazo, sim. Sem isso, ou o id se perde em silencio, ou
 * a tela repete para sempre um que nunca vai voltar.
 */

export type SituacaoDaBusca =
  /** Conversa carregada, com as mensagens. */
  | "OK"
  /** A API respondeu que nao existe — ou o id e de outra conta. */
  | "NAO_ENCONTRADA"
  /** A API recusou ou falhou. `tentarDeNovo` diz se adianta. */
  | "FALHOU"
  /** O prazo desta chamada acabou antes de chegar a vez dele. */
  | "NAO_INICIADA";

export interface BuscaDeSessao {
  sessionId: string;
  situacao: SituacaoDaBusca;
  /** Vale repetir este id num proximo lote. */
  tentarDeNovo: boolean;
  motivo?: string;
}

export interface FontesDaBusca {
  sessao: (params: {
    accountId: string;
    sessionId: string;
  }) => Promise<AdapterResult<ConversationSnapshot | null>>;
  contato: (params: {
    accountId: string;
    contactId: string;
  }) => Promise<AdapterResult<ContactSnapshot | null>>;
}

const FONTES_REAIS: FontesDaBusca = {
  sessao: (params) => sessionsAdapter.getWithMessages(params),
  contato: (params) => contactsAdapter.getById(params),
};

/**
 * Falhas que passam sozinhas: limite de requisicoes, tempo, rede, erro do
 * servidor da API. As demais — credencial, permissao, contrato — vao se
 * repetir identicas no proximo lote, e insistir so gasta a cota.
 */
const PASSAGEIRAS: ReadonlySet<ApiFailureKind> = new Set([
  "LIMITE_REQUISICOES",
  "TIMEOUT",
  "ERRO_REDE",
  "ERRO_API",
]);

function veredito(sessionId: string, erro: unknown): BuscaDeSessao {
  if (erro instanceof ApiError) {
    if (erro.kind === "NAO_ENCONTRADO") {
      return {
        sessionId,
        situacao: "NAO_ENCONTRADA",
        tentarDeNovo: false,
        motivo: "A plataforma nao encontrou este atendimento nesta conta.",
      };
    }
    return {
      sessionId,
      situacao: "FALHOU",
      tentarDeNovo: PASSAGEIRAS.has(erro.kind),
      motivo: erro.message,
    };
  }

  return {
    sessionId,
    situacao: "FALHOU",
    // Erro que nao veio da API e defeito nosso: repetir daria o mesmo.
    tentarDeNovo: false,
    motivo: erro instanceof Error ? erro.message : String(erro),
  };
}

export interface ResultadoDaBuscaPorId {
  conversas: ConversationSnapshot[];
  contatos: ContactSnapshot[];
  /** Na mesma ordem dos ids recebidos. */
  buscas: BuscaDeSessao[];
  sourceFailures: SourceFailure[];
  pendingValidation: string[];
}

export async function buscarConversasPorId(params: {
  accountId: string;
  sessionIds: string[];
  /** Instante (ms) a partir do qual nada novo comeca. */
  prazo: number;
  /**
   * Buscas simultaneas. O limitador de requisicoes ja segura a vazao por
   * grupo de endpoint; isto so evita abrir mais conexoes do que ele deixa
   * passar.
   */
  trabalhadores?: number;
  fontes?: FontesDaBusca;
}): Promise<ResultadoDaBuscaPorId> {
  const { accountId, prazo } = params;
  const fontes = params.fontes ?? FONTES_REAIS;
  const pendentes = new Set<string>();
  const sourceFailures: SourceFailure[] = [];

  const ids = [...new Set(params.sessionIds)];
  const porId = new Map<string, BuscaDeSessao>();
  // Pelo id PEDIDO, nao pelo que a API devolve: se ela escrever o id em
  // outra caixa, a conversa nao pode sumir da resposta com veredito "OK".
  const carregadas = new Map<string, ConversationSnapshot>();

  await emParalelo(ids, params.trabalhadores ?? 4, prazo, async (sessionId) => {
    try {
      const resultado = await fontes.sessao({ accountId, sessionId });
      resultado.pendingValidation.forEach((p) => pendentes.add(p));

      if (!resultado.data) {
        porId.set(sessionId, {
          sessionId,
          situacao: "NAO_ENCONTRADA",
          tentarDeNovo: false,
          motivo: "A resposta da plataforma nao trouxe um atendimento reconhecivel.",
        });
        return;
      }

      carregadas.set(sessionId, resultado.data);
      porId.set(sessionId, { sessionId, situacao: "OK", tentarDeNovo: false });
    } catch (erro) {
      porId.set(sessionId, veredito(sessionId, erro));
    }
  });

  /* --- Contatos das conversas carregadas ---------------------------------
   * Sem o contato o card sai sem nome e sem etiquetas — e as etiquetas atuais
   * sao o que diz se o lead ja foi trabalhado. Falhar aqui nao derruba a
   * conversa: ela e analisada igual, e a falha aparece contada.
   */
  const conversas = ids
    .map((id) => carregadas.get(id))
    .filter((c): c is ConversationSnapshot => c !== undefined);

  const contactIds = [
    ...new Set(conversas.map((c) => c.contactId).filter((id) => id.length > 0)),
  ];
  const contatos: ContactSnapshot[] = [];
  let contatosComFalha = 0;

  const { naoIniciados: contatosNaoBuscados } = await emParalelo(
    contactIds,
    params.trabalhadores ?? 4,
    prazo,
    async (contactId) => {
      try {
        const resultado = await fontes.contato({ accountId, contactId });
        resultado.pendingValidation.forEach((p) => pendentes.add(p));
        if (resultado.data) contatos.push(resultado.data);
      } catch {
        contatosComFalha += 1;
      }
    },
  );

  if (contatosComFalha + contatosNaoBuscados > 0) {
    sourceFailures.push({
      source: "Contatos",
      kind: "PARCIAL",
      message:
        `${contatosComFalha + contatosNaoBuscados} de ${contactIds.length} contato(s) ` +
        `nao foram carregados. Essas oportunidades aparecem sem nome e sem etiquetas.`,
    });
  }

  const buscas = ids.map(
    (sessionId): BuscaDeSessao =>
      porId.get(sessionId) ?? {
        sessionId,
        situacao: "NAO_INICIADA",
        tentarDeNovo: true,
        motivo: "O tempo desta rodada acabou antes; entra no proximo lote.",
      },
  );

  return {
    // Mesma ordem dos ids pedidos: o navegador ja mandou do mais recente
    // para o mais antigo.
    conversas,
    contatos,
    buscas,
    sourceFailures,
    pendingValidation: [...pendentes],
  };
}
