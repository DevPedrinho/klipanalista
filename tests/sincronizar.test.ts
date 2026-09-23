import { describe, expect, it } from "vitest";
import type { KlipflowiApi } from "@/lib/klipflowi/api";
import { KlipflowiError } from "@/lib/klipflowi/client";
import type { MessageRow, SessionRow } from "@/lib/klipflowi/mappers";
import { estadoInicial, executarRodada, type EstadoSync, type RepoSync } from "@/lib/sync/sincronizar";

const CORTE = new Date("2026-09-16T00:00:00Z");
const INICIO = "2026-09-23T12:00:00.000Z";

/** 3 páginas, da mais antiga (1) para a mais nova (3). Só a 3 e parte da 2 estão na janela. */
const PAGINAS: Record<number, unknown[]> = {
  1: [sessao("velha1", "2026-08-01T00:00:00Z"), sessao("velha2", "2026-08-02T00:00:00Z")],
  2: [sessao("velha3", "2026-09-01T00:00:00Z"), sessao("nova1", "2026-09-20T00:00:00Z")],
  3: [sessao("nova2", "2026-09-22T00:00:00Z"), sessao("nova3", "2026-09-23T00:00:00Z")],
};

function sessao(id: string, quando: string) {
  return { id, contactId: `c_${id}`, userId: "ag", createdAt: quando, lastInteractionDate: quando };
}

function apiFalsa(extra: Partial<KlipflowiApi> = {}) {
  const lidas: number[] = [];
  const api = {
    listarAtendentes: async () => [{ id: "ag", name: "Ana", profile: "AGENT" }],
    paginaDeConversas: async (n: number) => {
      lidas.push(n);
      return { items: PAGINAS[n] ?? [], totalPages: 3, totalItems: 6 };
    },
    listarMensagens: async (id: string) => [
      { id: `${id}_m1`, text: "quanto custa?", createdAt: "2026-09-22T10:00:00Z" },
      { id: `${id}_m2`, userId: "ag", type: "AUDIO", details: { transcription: { text: "custa 5 mil" } } },
    ],
    buscarContato: async (id: string) => ({ id, name: `Contato ${id}`, phoneNumber: "5511" }),
    ...extra,
  } as unknown as KlipflowiApi;
  return { api, lidas };
}

function repoEmMemoria() {
  const sessoes = new Map<string, SessionRow & { needs_message_sync: boolean; messages_synced_at?: string }>();
  const mensagens = new Map<string, MessageRow>();
  const contatos = new Set<string>();
  const repo: RepoSync = {
    salvarAtendentes: async () => {},
    estadoDasConversas: async (ids) =>
      new Map(ids.filter((i) => sessoes.has(i)).map((i) => [i, sessoes.get(i)!])),
    salvarConversas: async (rows) => rows.forEach((r) => sessoes.set(r.id, { ...sessoes.get(r.id), ...r })),
    conversasPendentes: async (limite, antes) =>
      [...sessoes.values()]
        .filter((s) => s.needs_message_sync && (!s.messages_synced_at || s.messages_synced_at < antes))
        .slice(0, limite)
        .map((s) => s.id),
    salvarMensagens: async (id, rows, resumo) => {
      rows.forEach((m) => mensagens.set(m.id, m));
      const s = sessoes.get(id)!;
      s.needs_message_sync = resumo.transcricao_em_andamento;
      s.messages_synced_at = "2026-09-23T12:00:01.000Z";
    },
    marcarErroMensagens: async (id) => {
      sessoes.get(id)!.messages_synced_at = "2026-09-23T12:00:01.000Z";
    },
    contatosFaltando: async (limite, ignorar) =>
      [...new Set([...sessoes.values()].map((s) => s.contact_id!))]
        .filter((c) => !contatos.has(c) && !ignorar.includes(c))
        .slice(0, limite),
    salvarContatos: async (rows) => rows.forEach((r) => contatos.add(r.id)),
  };
  return { repo, sessoes, mensagens, contatos };
}

const opcoes = { corte: CORTE, inicioDaSync: INICIO, orcamentoMs: 60_000 };

describe("executarRodada", () => {
  it("lê as páginas de trás para frente e para na primeira página fora da janela", async () => {
    const { api, lidas } = apiFalsa();
    const { repo, sessoes, mensagens, contatos } = repoEmMemoria();

    const fim = await executarRodada(estadoInicial(), api, repo, opcoes);

    expect(fim.fase).toBe("fim");
    expect(lidas).toEqual([1, 3, 2, 1]); // página 1 só para saber totalPages; depois 3 → 2 → 1 (fora)
    expect([...sessoes.keys()].sort()).toEqual(["nova1", "nova2", "nova3"]);
    expect(mensagens.size).toBe(6);
    expect(mensagens.get("nova1_m2")?.transcription).toBe("custa 5 mil");
    expect(contatos.size).toBe(3);
    expect(fim.stats).toMatchObject({ conversas: 3, conversasComMensagens: 3, mensagens: 6, audios: 3, erros: 0 });
  });

  it("retoma do cursor quando o orçamento acaba no meio", async () => {
    const { api } = apiFalsa();
    const { repo } = repoEmMemoria();
    let relogio = 0;
    // Cada chamada ao relógio avança 10s; orçamento de 25s interrompe cedo.
    const parcial = await executarRodada(estadoInicial(), api, repo, { ...opcoes, orcamentoMs: 25_000, agora: () => (relogio += 10_000) });
    expect(parcial.fase).not.toBe("fim");

    let estado: EstadoSync = parcial;
    for (let i = 0; i < 20 && estado.fase !== "fim"; i++) {
      estado = await executarRodada(estado, api, repo, opcoes);
    }
    expect(estado.fase).toBe("fim");
    expect(estado.stats.conversas).toBe(3);
  });

  it("não refaz a mesma conversa em loop quando a transcrição ainda está processando", async () => {
    const { api } = apiFalsa({
      listarMensagens: async () => [{ id: "x", type: "AUDIO", details: { transcription: { processing: true } } }],
    } as Partial<KlipflowiApi>);
    const { repo, sessoes } = repoEmMemoria();
    const fim = await executarRodada(estadoInicial(), api, repo, opcoes);
    expect(fim.fase).toBe("fim");
    expect(fim.stats.conversasComMensagens).toBe(3);
    expect(sessoes.get("nova1")?.needs_message_sync).toBe(true); // fica para a próxima sincronização
  });

  it("erro ao baixar mensagens de uma conversa não derruba a sincronização", async () => {
    const { api } = apiFalsa({
      listarMensagens: async (id: string) => {
        if (id === "nova2") throw new Error("falhou");
        return [];
      },
    } as Partial<KlipflowiApi>);
    const { repo } = repoEmMemoria();
    const fim = await executarRodada(estadoInicial(), api, repo, opcoes);
    expect(fim.fase).toBe("fim");
    expect(fim.stats.erros).toBe(1);
    expect(fim.stats.conversasComMensagens).toBe(2);
  });

  it("contato inexistente vira marcador e não é buscado de novo", async () => {
    const { api } = apiFalsa({
      buscarContato: async () => {
        throw new KlipflowiError("404", 404, null);
      },
    } as Partial<KlipflowiApi>);
    const { repo, contatos } = repoEmMemoria();
    const fim = await executarRodada(estadoInicial(), api, repo, opcoes);
    expect(fim.fase).toBe("fim");
    expect(contatos.size).toBe(3);
  });

  it("conversa sem mudança de interação não é marcada para baixar mensagens de novo", async () => {
    const { api } = apiFalsa();
    const { repo, sessoes } = repoEmMemoria();
    await executarRodada(estadoInicial(), api, repo, opcoes);
    // Banco devolve o instante em outro formato (+00:00): não pode contar como mudança.
    sessoes.get("nova3")!.last_interaction_at = "2026-09-23T00:00:00+00:00";
    await executarRodada(estadoInicial(), api, repo, { ...opcoes, inicioDaSync: "2026-09-24T00:00:00.000Z" });
    expect(sessoes.get("nova3")?.needs_message_sync).toBe(false);
  });
});
