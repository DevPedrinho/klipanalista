import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tag } from "@/domain/types";
import {
  TAG_TAXONOMY,
  recommendTagKeys,
  resolveTag,
  resolveTags,
} from "@/server/services/tag-taxonomy.service";
import {
  ENDPOINTS,
  listAllEndpoints,
  listPendingEndpoints,
  resolvePath,
} from "@/server/integration/endpoints";
import {
  OPERACAO_DE_ETIQUETAS,
  TAG_OPERATIONS,
} from "@/server/integration/adapters/contacts.adapter";
import { mapCard } from "@/server/integration/adapters/cards.adapter";
import { MappingReport } from "@/server/integration/mappers/tolerant";

/**
 * Testes da taxonomia de etiquetas e do registry de endpoints.
 *
 * Taxonomia: a regra do produto e NUNCA criar etiqueta duplicada e NUNCA
 * criar etiqueta nova sem aprovacao. Um bug aqui polui a base do cliente.
 *
 * Endpoints: nenhum contrato pendente pode ser chamado por engano.
 */

function tag(id: string, name: string): Tag {
  return { id, accountId: "acc1", name };
}

/* ==========================================================================
   Reutilizacao de etiquetas
   ========================================================================== */
describe("resolveTag", () => {
  it("reutiliza etiqueta com nome canonico exato", () => {
    const existentes = [tag("t1", "IA | Oportunidade quente")];
    const r = resolveTag("OPORTUNIDADE_QUENTE", existentes);

    assert.equal(r?.outcome, "REUSE_EXACT");
    assert.equal(r?.matched?.id, "t1");
  });

  it("reutiliza etiqueta equivalente da equipe por sinonimo", () => {
    // A equipe ja mantinha "Oportunidade quente" sem o prefixo "IA |".
    const existentes = [tag("t9", "Oportunidade quente")];
    const r = resolveTag("OPORTUNIDADE_QUENTE", existentes);

    assert.equal(r?.outcome, "REUSE_SYNONYM");
    assert.equal(r?.matched?.id, "t9", "deveria reaproveitar a etiqueta existente");
  });

  it("ignora acentuacao e caixa ao comparar", () => {
    const existentes = [tag("t5", "OBJEÇÃO DE PREÇO")];
    const r = resolveTag("OBJECAO_PRECO", existentes);

    assert.ok(r?.matched, "acento nao pode impedir o reaproveitamento");
    assert.equal(r?.matched?.id, "t5");
  });

  it("pede aprovacao quando nao existe equivalente", () => {
    const r = resolveTag("OPORTUNIDADE_QUENTE", [tag("t1", "Cliente VIP")]);

    assert.equal(r?.outcome, "NEEDS_APPROVAL");
    assert.equal(r?.matched, undefined);
  });

  it("nunca devolve uma instrucao de criar diretamente", () => {
    const r = resolveTag("URGENCIA", []);
    const permitidos = ["REUSE_EXACT", "REUSE_SYNONYM", "NEEDS_APPROVAL"];
    assert.ok(permitidos.includes(r!.outcome), "criacao livre nao e um desfecho valido");
  });

  it("sempre carrega a regra que motivou a aplicacao", () => {
    const r = resolveTag("FOLLOWUP_NECESSARIO", []);
    assert.ok(r?.rule && r.rule.length > 10, "a regra precisa ser auditavel");
  });

  it("devolve null para chave desconhecida", () => {
    assert.equal(resolveTag("CHAVE_INEXISTENTE", []), null);
  });
});

describe("resolveTags", () => {
  it("nao aplica a mesma etiqueta duas vezes", () => {
    // Uma unica etiqueta da conta que casa com duas chaves da taxonomia.
    const existentes = [tag("t1", "Follow-up")];
    const r = resolveTags(["FOLLOWUP_NECESSARIO", "FOLLOWUP_NECESSARIO"], existentes);

    assert.equal(r.length, 1, "chave repetida nao pode gerar duas aplicacoes");
  });

  it("evita duas chaves distintas caindo na mesma etiqueta", () => {
    const existentes = [tag("t1", "Oportunidade quente")];
    const r = resolveTags(["OPORTUNIDADE_QUENTE", "URGENCIA"], existentes);

    const ids = r.filter((x) => x.matched).map((x) => x.matched!.id);
    assert.equal(new Set(ids).size, ids.length, "etiqueta duplicada na mesma aplicacao");
  });

  it("descarta chaves invalidas silenciosamente", () => {
    const r = resolveTags(["URGENCIA", "NAO_EXISTE"], []);
    assert.equal(r.length, 1);
  });
});

/* ==========================================================================
   Catalogo
   ========================================================================== */
describe("TAG_TAXONOMY", () => {
  it("nao tem chaves nem nomes duplicados", () => {
    const chaves = TAG_TAXONOMY.map((t) => t.key);
    const nomes = TAG_TAXONOMY.map((t) => t.name);
    assert.equal(new Set(chaves).size, chaves.length, "chave duplicada");
    assert.equal(new Set(nomes).size, nomes.length, "nome duplicado");
  });

  it("usa o prefixo IA | em todas as etiquetas", () => {
    for (const t of TAG_TAXONOMY) {
      assert.ok(t.name.startsWith("IA | "), `${t.name} sem prefixo`);
    }
  });

  it("descreve a regra de cada etiqueta", () => {
    for (const t of TAG_TAXONOMY) {
      assert.ok(t.rule.length > 10, `${t.key} sem regra`);
      assert.ok(t.synonyms.length > 0, `${t.key} sem sinonimos`);
    }
  });
});

/* ==========================================================================
   Recomendacao de etiquetas
   ========================================================================== */
describe("recommendTagKeys", () => {
  const base = {
    score: 80,
    confidence: 80,
    hoursWithoutReply: 2,
    signalCodes: [] as string[],
    hasOpenCard: false,
    lastMessageFromContact: false,
  };

  it("marca como quente score alto e interacao recente", () => {
    assert.ok(recommendTagKeys(base).includes("OPORTUNIDADE_QUENTE"));
  });

  it("marca como em desenvolvimento score intermediario", () => {
    const r = recommendTagKeys({ ...base, score: 55 });
    assert.ok(r.includes("OPORTUNIDADE_DESENVOLVIMENTO"));
    assert.ok(!r.includes("OPORTUNIDADE_QUENTE"));
  });

  it("classifica suporte puro e para por ali", () => {
    const r = recommendTagKeys({ ...base, signalCodes: ["SUPORTE_APENAS"] });
    assert.deepEqual(r, ["ATENDIMENTO_SUPORTE"], "suporte nao deve virar oportunidade quente");
  });

  it("nao classifica como suporte quando ha sinal de compra junto", () => {
    const r = recommendTagKeys({
      ...base,
      signalCodes: ["SUPORTE_APENAS", "SOLICITACAO_PRECO"],
    });
    assert.ok(!r.includes("ATENDIMENTO_SUPORTE"));
  });

  it("sinaliza cliente sem retorno quando a bola esta com a equipe", () => {
    const r = recommendTagKeys({
      ...base, hoursWithoutReply: 30, lastMessageFromContact: true,
    });
    assert.ok(r.includes("CLIENTE_SEM_RETORNO"));
  });

  it("sinaliza dados incompletos quando a confianca e baixa", () => {
    assert.ok(recommendTagKeys({ ...base, confidence: 20 }).includes("DADOS_INCOMPLETOS"));
  });

  it("so recomenda chaves que existem na taxonomia", () => {
    const validas = new Set(TAG_TAXONOMY.map((t) => t.key));
    const combinacoes = [
      base,
      { ...base, score: 40, confidence: 20, hoursWithoutReply: 100, lastMessageFromContact: true },
      { ...base, signalCodes: ["RECOMPRA", "PEDIDO_DESCONTO", "URGENCIA", "PROPOSTA_ENVIADA"] },
      { ...base, signalCodes: ["FORA_PERFIL"] },
    ];

    for (const c of combinacoes) {
      for (const chave of recommendTagKeys(c)) {
        assert.ok(validas.has(chave), `chave fora da taxonomia: ${chave}`);
      }
    }
  });
});

/* ==========================================================================
   Registry de endpoints
   ========================================================================== */
describe("registry de endpoints", () => {
  it("nao tem chaves duplicadas", () => {
    const chaves = listAllEndpoints().map((e) => e.key);
    assert.equal(new Set(chaves).size, chaves.length);
  });

  it("marca como pendente todo contrato com pendencia declarada", () => {
    for (const e of listAllEndpoints()) {
      const esperado = e.pending.length === 0 ? "CONFIRMED" : "PENDING_VALIDATION";
      assert.equal(e.trust, esperado, `${e.key} com trust inconsistente`);
    }
  });

  it("todo contrato confirmado tem caminho preenchido", () => {
    for (const e of listAllEndpoints()) {
      if (e.trust === "CONFIRMED") {
        assert.ok(e.path.length > 0, `${e.key} confirmado sem caminho`);
        assert.ok(e.path.startsWith("/"), `${e.key} com caminho relativo`);
      }
    }
  });

  it("mantem os endpoints de conversa como confirmados", () => {
    // Estes vieram do indice oficial e o prefixo `chat` esta citado na doc.
    assert.equal(ENDPOINTS.SESSIONS.LIST.trust, "CONFIRMED");
    assert.equal(ENDPOINTS.SESSIONS.LIST.path, "/v2/session");
    assert.equal(ENDPOINTS.MESSAGES.LIST_BY_SESSION.path, "/v1/session/{id}/message");
  });

  it("mantem o login integrado como pendente e sem caminho", () => {
    const contrato = ENDPOINTS.AUTH.INTEGRATED_LOGIN;
    assert.equal(contrato.trust, "PENDING_VALIDATION");
    assert.equal(contrato.path, "", "nao pode haver caminho inventado");
  });

  it("lista as pendencias para o diagnostico", () => {
    const pendentes = listPendingEndpoints();
    assert.ok(pendentes.length > 0);
    for (const e of pendentes) {
      assert.ok(e.pending.length > 0, `${e.key} pendente sem motivo declarado`);
    }
  });
});

describe("resolvePath", () => {
  it("substitui os parametros do caminho", () => {
    const p = resolvePath(ENDPOINTS.SESSIONS.GET_BY_ID, { id: "sess_123" });
    assert.equal(p, "/v2/session/sess_123");
  });

  it("codifica valores para nao permitir travessia de caminho", () => {
    const p = resolvePath(ENDPOINTS.SESSIONS.GET_BY_ID, { id: "../admin" });
    assert.ok(!p.includes("../"), "travessia de caminho nao pode passar");
  });

  it("falha quando falta um parametro em vez de montar URL errada", () => {
    assert.throws(
      () => resolvePath(ENDPOINTS.SESSIONS.GET_BY_ID, {}),
      /Parametro "id" ausente/,
    );
  });

  it("falha em contrato sem caminho conhecido", () => {
    assert.throws(
      () => resolvePath(ENDPOINTS.AUTH.INTEGRATED_LOGIN, {}),
      /nao possui caminho definido/,
    );
  });
});

/* ==========================================================================
   Operação de etiquetas — trava de segurança
   ==========================================================================
   A API aceita três operações, e uma delas é destrutiva. Este bloco existe
   para que ninguém troque a operação por engano num refactor futuro.
   ========================================================================== */
describe("operacao usada ao aplicar etiquetas", () => {
  it("usa InsertIfNotExists, que apenas acrescenta", () => {
    assert.equal(OPERACAO_DE_ETIQUETAS, "InsertIfNotExists");
  });

  it("NUNCA usa ReplaceAll, que apagaria as etiquetas da equipe", () => {
    assert.notEqual(
      OPERACAO_DE_ETIQUETAS,
      TAG_OPERATIONS.SUBSTITUIR_TUDO,
      "ReplaceAll remove todas as etiquetas do contato antes de gravar",
    );
  });

  it("NUNCA usa DeleteIfExists ao aplicar", () => {
    assert.notEqual(OPERACAO_DE_ETIQUETAS, TAG_OPERATIONS.REMOVER_SE_PRESENTE);
  });

  it("mantem os literais exatos aceitos pela API", () => {
    // Trocar qualquer um destes por um valor inventado faria a API recusar.
    assert.equal(TAG_OPERATIONS.INSERIR_SE_AUSENTE, "InsertIfNotExists");
    assert.equal(TAG_OPERATIONS.REMOVER_SE_PRESENTE, "DeleteIfExists");
    assert.equal(TAG_OPERATIONS.SUBSTITUIR_TUDO, "ReplaceAll");
  });
});

/* ==========================================================================
   Grupos de serviço confirmados pela documentação
   ========================================================================== */
describe("grupos de servico", () => {
  it("contatos ficam em core (URL literal na documentacao)", () => {
    assert.equal(ENDPOINTS.CONTACTS.SET_TAGS.group, "core");
    assert.equal(ENDPOINTS.CONTACTS.SET_TAGS.trust, "CONFIRMED");
  });

  it("conversas e mensagens ficam em chat", () => {
    assert.equal(ENDPOINTS.SESSIONS.LIST.group, "chat");
    assert.equal(ENDPOINTS.MESSAGES.LIST_BY_SESSION.group, "chat");
  });

  it("paineis e cards ficam em crm, nao em core", () => {
    // O menu da documentacao separa Crm de Core. Marcar como core produziria 404.
    assert.equal(ENDPOINTS.PANELS.LIST.group, "crm");
    assert.equal(ENDPOINTS.CARDS.LIST.group, "crm");
    assert.equal(ENDPOINTS.CARDS.UPDATE.group, "crm");
    assert.equal(ENDPOINTS.CARD_NOTES.CREATE.group, "crm");
  });
});

/* ==========================================================================
   Contrato de card — nomes que eu havia errado
   ==========================================================================
   Os quatro campos abaixo foram assumidos errado antes da documentação chegar.
   Em modo real isso traria cards sem contato, sem responsável e sem valor —
   e o indicador "Valor potencial estimado" mostraria zero.
   ========================================================================== */
describe("mapeamento de card", () => {
  const cardDaApi = {
    id: "c1",
    panelId: "p1",
    panelTitle: "Funil de Vendas",
    stepId: "s1",
    stepTitle: "Proposta Quente",
    stepPhase: "NONE",
    title: "Oportunidade",
    // Os nomes que a API realmente usa:
    contactIds: ["ct1", "ct2"],
    responsibleUserId: "u1",
    responsibleUser: { id: "u1", name: "Ana Ribeiro" },
    monetaryAmount: 96400,
    sessionId: "sess1",
    dueDate: "2026-10-01T12:00:00Z",
    isOverdue: false,
    status: "OPEN",
    createdAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
  };

  it("le a lista de contatos, nao um contato unico", () => {
    const card = mapCard(cardDaApi, "acc1", new MappingReport());
    assert.deepEqual(card?.contactIds, ["ct1", "ct2"]);
    assert.equal(card?.contactId, "ct1", "o atalho aponta para o primeiro");
  });

  it("le o responsavel de responsibleUserId", () => {
    const card = mapCard(cardDaApi, "acc1", new MappingReport());
    assert.equal(card?.responsibleId, "u1");
    assert.equal(card?.responsibleName, "Ana Ribeiro");
  });

  it("le o valor de monetaryAmount", () => {
    const card = mapCard(cardDaApi, "acc1", new MappingReport());
    assert.equal(card?.amount, 96400, "sem isto, o valor do funil seria zero");
  });

  it("le a fase da etapa", () => {
    const card = mapCard(cardDaApi, "acc1", new MappingReport());
    assert.equal(card?.stepPhase, "NONE");
    assert.equal(card?.stepName, "Proposta Quente");
  });

  it("nao aceita os nomes antigos que eu havia inventado", () => {
    // Um payload com os nomes errados nao deve preencher nada por acidente.
    const payloadErrado = {
      id: "c2",
      panelId: "p1",
      stepId: "s1",
      title: "x",
      contactId: "ct9",
      responsibleId: "u9",
      amount: 1234,
      status: "OPEN",
    };
    const card = mapCard(payloadErrado, "acc1", new MappingReport());

    assert.deepEqual(card?.contactIds, []);
    assert.equal(card?.responsibleId, undefined);
    assert.equal(card?.amount, undefined);
  });

  it("le o motivo de perda quando o card esta perdido", () => {
    const perdido = {
      ...cardDaApi,
      status: "LOST",
      lostReason: { id: "lr1", name: "Fechou com concorrente" },
    };
    const card = mapCard(perdido, "acc1", new MappingReport());
    assert.equal(card?.status, "LOST");
    assert.equal(card?.lostReasonId, "lr1");
    assert.equal(card?.lostReasonName, "Fechou com concorrente");
  });

  it("descarta card sem id em vez de fabricar um", () => {
    assert.equal(mapCard({ title: "sem id" }, "acc1", new MappingReport()), null);
  });
});
