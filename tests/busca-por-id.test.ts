import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { MAX_IDS_POR_LOTE, POST } from "@/app/api/intelligence/analisar-lote/route";
import { ApiError, type ApiFailureKind } from "@/server/integration/http/client";
import { buscarConversasPorId, type FontesDaBusca } from "@/server/services/busca-por-id.service";
import type { ContactSnapshot, ConversationSnapshot } from "@/domain/types";

/**
 * Busca de atendimentos pelo id que veio da planilha.
 *
 * A importação de um mês são dezenas de rodadas. O que estes testes protegem
 * é o veredito por id: o navegador decide o que repetir por ele. Errar para
 * um lado perde atendimento em silêncio; para o outro, repete para sempre um
 * id que nunca vai voltar.
 */

const ID = (n: number) => `aaaaaaaa-1d90-4792-8f74-${n.toString(16).padStart(12, "0")}`;
const LONGE = () => Date.now() + 60_000;

function conversa(id: string, contactId = `contato-${id.slice(-2)}`): ConversationSnapshot {
  return {
    id,
    accountId: "klipflowi",
    contactId,
    channel: "WHATSAPP",
    status: "OPEN",
    startedAt: "2026-09-16T18:00:00.000Z",
    lastMessageAt: "2026-09-16T18:30:00.000Z",
    messages: [
      {
        id: `m-${id}`,
        sessionId: id,
        direction: "INBOUND",
        text: "Quero um orçamento",
        sentAt: "2026-09-16T18:30:00.000Z",
      },
    ],
  };
}

function contato(id: string): ContactSnapshot {
  return {
    id,
    accountId: "klipflowi",
    name: `Nome ${id}`,
    tagIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function erroDaApi(kind: ApiFailureKind): ApiError {
  return new ApiError({ kind, message: `falha ${kind}`, endpointKey: "SESSIONS.GET_BY_ID" });
}

/** Fontes de mentira: cada id responde o que a tabela mandar. */
function fontes(
  porId: Record<string, ConversationSnapshot | null | Error>,
  contatos: Record<string, ContactSnapshot | Error> = {},
): FontesDaBusca & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async sessao({ sessionId }) {
      chamadas.push(sessionId);
      const resposta = porId[sessionId];
      if (resposta instanceof Error) throw resposta;
      return { data: resposta ?? null, source: "live", pendingValidation: [] };
    },
    async contato({ contactId }) {
      const resposta = contatos[contactId];
      if (resposta instanceof Error) throw resposta;
      return { data: resposta ?? contato(contactId), source: "live", pendingValidation: [] };
    },
  };
}

describe("veredito por atendimento", () => {
  it("devolve as conversas e os contatos, na ordem em que os ids vieram", async () => {
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(2), ID(1)],
      prazo: LONGE(),
      fontes: fontes({ [ID(1)]: conversa(ID(1)), [ID(2)]: conversa(ID(2)) }),
    });

    assert.deepEqual(resultado.conversas.map((c) => c.id), [ID(2), ID(1)]);
    assert.equal(resultado.contatos.length, 2);
    assert.deepEqual(
      resultado.buscas.map((b) => [b.sessionId, b.situacao, b.tentarDeNovo]),
      [
        [ID(2), "OK", false],
        [ID(1), "OK", false],
      ],
    );
  });

  it("atendimento que não existe não volta para a fila", async () => {
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1), ID(2)],
      prazo: LONGE(),
      fontes: fontes({ [ID(1)]: erroDaApi("NAO_ENCONTRADO"), [ID(2)]: null }),
    });

    for (const busca of resultado.buscas) {
      assert.equal(busca.situacao, "NAO_ENCONTRADA");
      assert.equal(busca.tentarDeNovo, false, `${busca.sessionId} voltaria para sempre`);
    }
  });

  /**
   * Limite de requisições é o erro MAIS provável numa importação de mil
   * atendimentos. Ele passa sozinho; o id não pode ser dado como perdido.
   */
  it("falha passageira volta para a fila; falha permanente, não", async () => {
    const passageiras: ApiFailureKind[] = ["LIMITE_REQUISICOES", "TIMEOUT", "ERRO_REDE", "ERRO_API"];
    const permanentes: ApiFailureKind[] = ["NAO_AUTENTICADO", "SEM_PERMISSAO", "CONTRATO_NAO_VALIDADO"];

    const tabela: Record<string, Error> = {};
    const todos = [...passageiras, ...permanentes];
    todos.forEach((kind, i) => {
      tabela[ID(i)] = erroDaApi(kind);
    });

    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: todos.map((_, i) => ID(i)),
      prazo: LONGE(),
      fontes: fontes(tabela),
    });

    resultado.buscas.forEach((busca, i) => {
      assert.equal(busca.situacao, "FALHOU");
      assert.equal(busca.tentarDeNovo, i < passageiras.length, `${todos[i]} classificado errado`);
      assert.match(busca.motivo ?? "", /falha/, "a tela precisa dizer o porquê");
    });
  });

  it("defeito nosso, fora da API, não é repetido", async () => {
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1)],
      prazo: LONGE(),
      fontes: fontes({ [ID(1)]: new TypeError("quebrou") }),
    });

    assert.equal(resultado.buscas[0]?.situacao, "FALHOU");
    assert.equal(resultado.buscas[0]?.tentarDeNovo, false);
  });

  it("o que o prazo não alcançou volta para a fila, sem chamar a API", async () => {
    const f = fontes({ [ID(1)]: conversa(ID(1)) });
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1), ID(2)],
      prazo: Date.now() - 1,
      fontes: f,
    });

    assert.equal(f.chamadas.length, 0);
    for (const busca of resultado.buscas) {
      assert.equal(busca.situacao, "NAO_INICIADA");
      assert.equal(busca.tentarDeNovo, true);
    }
  });

  it("id repetido no pedido é buscado uma vez só", async () => {
    const f = fontes({ [ID(1)]: conversa(ID(1)) });
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1), ID(1)],
      prazo: LONGE(),
      fontes: f,
    });

    assert.equal(f.chamadas.length, 1);
    assert.equal(resultado.buscas.length, 1);
  });

  it("conversa devolvida com o id em outra caixa não some da resposta", async () => {
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1)],
      prazo: LONGE(),
      fontes: fontes({ [ID(1)]: conversa(ID(1).toUpperCase()) }),
    });

    assert.equal(resultado.buscas[0]?.situacao, "OK");
    assert.equal(resultado.conversas.length, 1, "OK sem conversa seria mentira");
  });
});

describe("contatos das conversas buscadas", () => {
  it("contato que falha não derruba a conversa, e a falha aparece contada", async () => {
    const resultado = await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1), ID(2)],
      prazo: LONGE(),
      fontes: fontes(
        { [ID(1)]: conversa(ID(1), "c1"), [ID(2)]: conversa(ID(2), "c2") },
        { c1: erroDaApi("LIMITE_REQUISICOES") },
      ),
    });

    assert.equal(resultado.conversas.length, 2);
    assert.deepEqual(resultado.contatos.map((c) => c.id), ["c2"]);
    assert.equal(resultado.sourceFailures.length, 1);
    assert.match(resultado.sourceFailures[0]?.message ?? "", /1 de 2 contato/);
  });

  it("dois atendimentos do mesmo cliente buscam o contato uma vez", async () => {
    let buscasDeContato = 0;
    const base = fontes({ [ID(1)]: conversa(ID(1), "c1"), [ID(2)]: conversa(ID(2), "c1") });

    await buscarConversasPorId({
      accountId: "klipflowi",
      sessionIds: [ID(1), ID(2)],
      prazo: LONGE(),
      fontes: {
        sessao: base.sessao,
        async contato(params) {
          buscasDeContato += 1;
          return base.contato(params);
        },
      },
    });

    assert.equal(buscasDeContato, 1);
  });
});

describe("rota de análise por lote — pelos ids", () => {
  function pedido(corpo: unknown): NextRequest {
    return new NextRequest("http://localhost/api/intelligence/analisar-lote", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    });
  }

  const BASE = { accountId: "acc_klipflowi_demo", userId: "user_ana" };

  it("recusa id que não é UUID — ele iria para o caminho da URL da API", async () => {
    const resposta = await POST(pedido({ ...BASE, sessionIds: ["../contact/123"] }));
    assert.equal(resposta.status, 400);
  });

  it("recusa lote acima do teto", async () => {
    const ids = Array.from({ length: MAX_IDS_POR_LOTE + 1 }, (_, i) => ID(i));
    const resposta = await POST(pedido({ ...BASE, sessionIds: ids }));
    assert.equal(resposta.status, 400);
  });

  it("recusa pedido sem nenhuma das duas entradas, ou com as duas", async () => {
    assert.equal((await POST(pedido(BASE))).status, 400);
    assert.equal(
      (await POST(pedido({ ...BASE, sessionIds: [ID(1)], conversas: [conversa(ID(1))] }))).status,
      400,
    );
  });

  /**
   * Sem nenhuma conversa carregada não há o que analisar — mas os vereditos
   * têm de voltar, ou a tela não sabe o que fazer com aqueles ids.
   */
  it("devolve os vereditos mesmo quando nada foi carregado", async () => {
    const resposta = await POST(pedido({ ...BASE, sessionIds: [ID(1), ID(2)] }));
    assert.equal(resposta.status, 200);

    const dados = ((await resposta.json()) as { data: Record<string, unknown> }).data;
    const buscas = dados["buscas"] as Array<{ sessionId: string; situacao: string }>;

    assert.deepEqual(buscas.map((b) => b.sessionId), [ID(1), ID(2)]);
    assert.ok(buscas.every((b) => b.situacao === "NAO_ENCONTRADA"), "o dataset simulado não os tem");
    assert.equal(dados["conversasRecebidas"], 0);
  });
});
