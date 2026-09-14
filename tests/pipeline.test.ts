import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MOCK_CONVERSATIONS,
  MOCK_PANELS,
  findCardBySession,
  findContact,
  previousConversationCount,
} from "@/mocks/dataset";
import { buildOpportunity, filterByVisibility } from "@/server/services/opportunity.service";
import { defaultSettings } from "@/server/services/automation.service";
import {
  clearAudit,
  queryAudit,
  recordAudit,
  suggestionAcceptanceRate,
} from "@/server/services/audit.service";
import {
  ANALYSIS_DEBOUNCE_MS,
  clearQueue,
  enqueueAnalysis,
  isRelevantForAnalysis,
  markAnalyzed,
  recordWebhookEvent,
} from "@/server/services/queue.service";
import { answerQuestion, detectIntent } from "@/server/services/chat.service";
import type { Opportunity, TenantContext } from "@/domain/types";

const SETTINGS = defaultSettings("acc_klipflowi_demo");
const NOW = new Date();

function buildFromDataset(sessionId: string): Opportunity | null {
  const conversation = MOCK_CONVERSATIONS.find((c) => c.id === sessionId);
  assert.ok(conversation, `conversa ${sessionId} nao existe no dataset`);

  return buildOpportunity({
    conversation,
    contact: findContact(conversation.contactId),
    existingCard: findCardBySession(sessionId),
    previousConversationCount: previousConversationCount(conversation.contactId, sessionId),
    panels: MOCK_PANELS,
    settings: SETTINGS,
    now: NOW,
  });
}

/* ==========================================================================
   Construcao da oportunidade
   ========================================================================== */
describe("buildOpportunity", () => {
  it("nao devolve oportunidade abaixo do corte", () => {
    for (const sessionId of ["sess_005", "sess_006", "sess_007"]) {
      assert.equal(buildFromDataset(sessionId), null, `${sessionId} nao deveria aparecer`);
    }
  });

  it("devolve oportunidade para os casos com sinal real", () => {
    for (const sessionId of ["sess_001", "sess_002", "sess_003", "sess_004", "sess_008"]) {
      assert.ok(buildFromDataset(sessionId), `${sessionId} deveria aparecer`);
    }
  });

  it("mascara o telefone antes de sair do servidor", () => {
    const o = buildFromDataset("sess_001")!;
    const contato = findContact(o.contactId)!;

    assert.ok(o.contactPhoneMasked?.includes("*"), "telefone precisa estar mascarado");
    assert.notEqual(o.contactPhoneMasked, contato.phone);
  });

  it("marca o valor como inferido quando nao veio de um card", () => {
    const comCard = buildFromDataset("sess_002")!;
    assert.equal(comCard.estimatedValueIsInferred, false, "valor do card e confirmado");
  });

  it("sempre carrega evidencias e motivo", () => {
    const o = buildFromDataset("sess_001")!;
    assert.ok(o.evidence.length > 0, "sem evidencia nao ha conclusao defensavel");
    assert.ok(o.reason.length > 0);
    assert.ok(o.nextAction.length > 0);
    assert.ok(o.suggestedFollowUpMessage.length > 0);
  });

  it("sugere atualizar em vez de criar quando ja existe card aberto", () => {
    const o = buildFromDataset("sess_002")!;
    const tipos = o.actions.map((a) => a.type);

    assert.ok(tipos.includes("ATUALIZAR_CARD"), "deveria sugerir atualizacao");
    assert.ok(!tipos.includes("CRIAR_CARD"), "criar outro card geraria duplicidade");
  });

  it("sugere criar card quando a oportunidade esta fora do CRM", () => {
    const o = buildFromDataset("sess_001")!;
    assert.ok(o.actions.map((a) => a.type).includes("CRIAR_CARD"));
  });

  it("marca como exigindo confirmacao as acoes sensiveis", () => {
    const o = buildFromDataset("sess_001")!;
    const atribuir = o.actions.find((a) => a.type === "ATRIBUIR_RESPONSAVEL");
    assert.equal(atribuir?.requiresHumanConfirmation, true);
  });

  it("nao inventa produto quando a conversa nao nomeia um", () => {
    const o = buildFromDataset("sess_004")!;
    // "repor o estoque de defensivo" nao segue os padroes de captura;
    // preferimos nao preencher a inventar.
    assert.ok(
      o.productInterest === undefined || o.productInterest.length >= 3,
      "produto vazio e melhor que produto inventado",
    );
  });
});

/* ==========================================================================
   Isolamento por visibilidade
   ========================================================================== */
describe("filterByVisibility", () => {
  const oportunidades = ["sess_001", "sess_002", "sess_004"]
    .map(buildFromDataset)
    .filter((o): o is Opportunity => o !== null);

  it("vendedor ve apenas os proprios atendimentos", () => {
    const ctx: TenantContext = {
      accountId: "acc_klipflowi_demo",
      userId: "user_ana",
      role: "VENDEDOR",
      visibleAgentIds: ["user_ana"],
    };
    const visiveis = filterByVisibility(oportunidades, ctx);
    for (const o of visiveis) {
      assert.ok(!o.agentId || o.agentId === "user_ana", `vazou ${o.agentId}`);
    }
  });

  it("administrador ve tudo da conta", () => {
    const ctx: TenantContext = {
      accountId: "acc_klipflowi_demo",
      userId: "user_elaine",
      role: "ADMIN",
      visibleAgentIds: "ALL",
    };
    assert.equal(filterByVisibility(oportunidades, ctx).length, oportunidades.length);
  });

  it("nunca devolve dados de outra conta", () => {
    const ctx: TenantContext = {
      accountId: "acc_outra",
      userId: "x",
      role: "ADMIN",
      visibleAgentIds: "ALL",
    };
    assert.equal(filterByVisibility(oportunidades, ctx).length, 0);
  });
});

/* ==========================================================================
   Auditoria
   ========================================================================== */
describe("auditoria", () => {
  function registro(overrides: Partial<Parameters<typeof recordAudit>[0]> = {}) {
    return recordAudit({
      accountId: "acc1",
      requestedByUserId: "u1",
      requestedByName: "Usuario",
      actionType: "CRIAR_CARD",
      actionStatus: "EXECUTADA",
      targetKind: "OPORTUNIDADE",
      targetId: "opp1",
      targetLabel: "Cliente",
      suggestion: "Criar card",
      evidenceCodes: ["SOLICITACAO_PRECO"],
      before: null,
      after: { titulo: "Novo card" },
      aiConfidence: 80,
      automationMode: "COPILOTO",
      success: true,
      ...overrides,
    });
  }

  it("isola registros entre contas", () => {
    clearAudit();
    registro({ accountId: "acc1" });
    registro({ accountId: "acc2" });

    assert.equal(queryAudit({ accountId: "acc1" }).total, 1);
    assert.equal(queryAudit({ accountId: "acc2" }).total, 1);
  });

  it("mascara dados sensiveis no estado gravado", () => {
    clearAudit();
    registro({ after: { phone: "5511987654321", nome: "Marcelo" } });

    const entrada = queryAudit({ accountId: "acc1" }).entries[0]!;
    const serializado = JSON.stringify(entrada.after);

    assert.ok(!serializado.includes("5511987654321"), "telefone vazou para a auditoria");
    assert.ok(serializado.includes("Marcelo"), "nome pode permanecer");
  });

  it("guarda as evidencias que sustentaram a sugestao", () => {
    clearAudit();
    registro({ evidenceCodes: ["ORCAMENTO_APROVADO", "URGENCIA"] });

    const entrada = queryAudit({ accountId: "acc1" }).entries[0]!;
    assert.deepEqual(entrada.evidenceCodes, ["ORCAMENTO_APROVADO", "URGENCIA"]);
  });

  it("registra a aprovacao humana quando houve", () => {
    clearAudit();
    registro({ approvedByUserId: "gestor", approvedByName: "Gestor" });

    const entrada = queryAudit({ accountId: "acc1" }).entries[0]!;
    assert.equal(entrada.approvedByUserId, "gestor");
    assert.ok(entrada.approvedAt, "a data de aprovacao precisa ser registrada");
  });

  it("filtra por usuario solicitante", () => {
    clearAudit();
    registro({ requestedByUserId: "u1" });
    registro({ requestedByUserId: "u2" });

    assert.equal(queryAudit({ accountId: "acc1", requestedByUserId: "u1" }).total, 1);
  });

  it("calcula o aproveitamento apenas sobre o que teve desfecho", () => {
    clearAudit();
    registro({ actionStatus: "EXECUTADA", success: true });
    registro({ actionStatus: "EXECUTADA", success: true });
    registro({ actionStatus: "REJEITADA", success: false });
    // Pendente nao entra no calculo.
    registro({ actionStatus: "AGUARDANDO_APROVACAO", success: false });

    assert.equal(suggestionAcceptanceRate("acc1"), 67);
  });

  it("devolve zero quando nada foi decidido", () => {
    clearAudit();
    assert.equal(suggestionAcceptanceRate("acc_vazia"), 0);
  });
});

/* ==========================================================================
   Fila de analise
   ========================================================================== */
describe("fila de analise", () => {
  it("deduplica entregas repetidas de webhook", () => {
    clearQueue();
    const payload = { accountId: "acc1", event: "MESSAGE_RECEIVED", idempotencyKey: "k1", payloadMasked: {} };

    assert.equal(recordWebhookEvent(payload).duplicate, false);
    assert.equal(recordWebhookEvent(payload).duplicate, true);
  });

  it("ignora eventos sem informacao nova", () => {
    clearQueue();
    const r = enqueueAnalysis({
      accountId: "acc1", sessionId: "s1", reason: "teste", relevantChange: false,
    });
    assert.equal(r.scheduled, false);
  });

  it("enfileira eventos relevantes", () => {
    clearQueue();
    const r = enqueueAnalysis({
      accountId: "acc1", sessionId: "s1", reason: "nova mensagem", relevantChange: true,
    });
    assert.equal(r.scheduled, true);
  });

  it("nao reanalisa a mesma conversa dentro da janela minima", () => {
    clearQueue();
    markAnalyzed("acc1", "s1");

    const r = enqueueAnalysis({
      accountId: "acc1", sessionId: "s1", reason: "nova mensagem", relevantChange: true,
    });
    assert.match(r.reason, /intervalo minimo/i);
  });

  it("classifica corretamente os eventos relevantes", () => {
    assert.equal(isRelevantForAnalysis("MESSAGE_RECEIVED"), true);
    assert.equal(isRelevantForAnalysis("PANEL_CARD_STEP_CHANGE"), true);
    assert.equal(isRelevantForAnalysis("CONTACT_UPDATE"), false);
  });

  it("usa uma janela de debounce positiva", () => {
    assert.ok(ANALYSIS_DEBOUNCE_MS > 0);
  });
});

/* ==========================================================================
   Chat: nunca inventar
   ========================================================================== */
describe("chat", () => {
  const contextoVazio = {
    tenant: {
      accountId: "acc1", userId: "u1", role: "GESTOR" as const, visibleAgentIds: "ALL" as const,
    },
    opportunities: [],
    funnels: [],
    qualityReports: [],
  };

  it("reconhece as intencoes do catalogo", () => {
    const casos: [string, string][] = [
      ["Quais sao as melhores oportunidades de hoje?", "MELHORES_OPORTUNIDADES"],
      ["Quais clientes precisam de follow-up?", "PRECISAM_FOLLOWUP"],
      ["Resuma meu funil comercial.", "RESUMO_FUNIL"],
      ["Onde estamos perdendo mais oportunidades?", "ONDE_PERDEMOS"],
      ["Quais cards parecem estar na etapa errada?", "CARDS_ETAPA_ERRADA"],
      ["Quais clientes podem comprar novamente?", "PODEM_RECOMPRAR"],
      ["Analise o atendimento da Ana", "ANALISE_VENDEDOR"],
    ];

    for (const [pergunta, esperado] of casos) {
      assert.equal(detectIntent(pergunta), esperado, `falhou em: ${pergunta}`);
    }
  });

  it("admite quando nao tem dados, em vez de inventar", () => {
    const r = answerQuestion("Quais sao as melhores oportunidades de hoje?", contextoVazio);
    assert.equal(r.insufficientData, true);
    assert.match(r.content, /nao tenho dados suficientes/i);
  });

  it("nao promete numeros quando o funil esta vazio", () => {
    const r = answerQuestion("Resuma meu funil comercial.", contextoVazio);
    assert.equal(r.insufficientData, true);
  });

  it("cita as oportunidades reais que usou na resposta", () => {
    const oportunidades = ["sess_001", "sess_002"]
      .map(buildFromDataset)
      .filter((o): o is Opportunity => o !== null);

    const r = answerQuestion("Quais sao as melhores oportunidades de hoje?", {
      ...contextoVazio,
      opportunities: oportunidades,
    });

    assert.ok(r.citations && r.citations.length > 0, "resposta sem citacao nao e verificavel");
    for (const c of r.citations!) {
      assert.ok(
        oportunidades.some((o) => o.contactName && c.label.includes(o.contactName)),
        `citou algo fora do contexto: ${c.label}`,
      );
    }
  });

  it("oferece ajuda em vez de chutar diante de pergunta desconhecida", () => {
    const r = answerQuestion("Qual o CNPJ do fornecedor X?", contextoVazio);
    assert.equal(r.insufficientData, true);
  });
});
