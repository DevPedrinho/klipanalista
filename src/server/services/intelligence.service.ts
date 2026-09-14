import "server-only";
import type {
  AgentQualityReport,
  ConversationSnapshot,
  CrmCard,
  FunnelStepSummary,
  FunnelSummary,
  IntegrationSettings,
  IntelligenceFilters,
  IntelligenceKpis,
  MisplacedCard,
  Opportunity,
  Panel,
  Recommendation,
  TenantContext,
} from "@/domain/types";
import {
  agentsAdapter,
  cardsAdapter,
  contactsAdapter,
  messagesAdapter,
  panelsAdapter,
  sessionsAdapter,
  tagsAdapter,
} from "@/server/integration/adapters";
import { shouldUseMock } from "@/server/integration/adapters/base";
import { detectSignals } from "@/server/scoring/signals";
import { suggestionAcceptanceRate } from "./audit.service";
import {
  buildOpportunity,
  computeKpis,
  filterByVisibility,
} from "./opportunity.service";
import { buildQualityReport } from "./quality.service";
import { getSettings } from "./settings.service";

/**
 * Orquestrador da Central de Inteligencia Comercial.
 *
 * Carrega os snapshots pelos adapters, roda o motor de analise e devolve
 * tudo o que a interface precisa, ja filtrado pelo escopo do usuario.
 *
 * Nenhuma escrita acontece aqui: este servico so LE e ANALISA.
 */

export interface IntelligenceOverview {
  kpis: IntelligenceKpis;
  opportunities: Opportunity[];
  funnels: FunnelSummary[];
  qualityReports: AgentQualityReport[];
  recommendations: Recommendation[];
  settings: IntegrationSettings;
  lastAnalysisAt: string;
  dataMode: "mock" | "live";
  pendingValidation: string[];
}

/** Dias sem movimentacao a partir dos quais um card conta como parado. */
const STALLED_DAYS = 7;

export async function loadOverview(params: {
  context: TenantContext;
  filters: IntelligenceFilters;
  now?: Date;
}): Promise<IntelligenceOverview> {
  const now = params.now ?? new Date();
  const { context, filters } = params;
  const accountId = context.accountId;
  const pending = new Set<string>();

  const collect = (messages: string[]) => messages.forEach((m) => pending.add(m));

  /* --- Carregamento paralelo dos snapshots ------------------------------- */
  const [sessionsRes, contactsRes, panelsRes, cardsRes, usersRes, tagsRes] = await Promise.all([
    sessionsAdapter.list({ accountId, updatedAfter: filters.period.from }),
    contactsAdapter.list({ accountId }),
    panelsAdapter.list({ accountId }),
    cardsAdapter.list({ accountId }),
    agentsAdapter.list({ accountId }),
    tagsAdapter.list({ accountId }),
  ]);

  collect(sessionsRes.pendingValidation);
  collect(contactsRes.pendingValidation);
  collect(panelsRes.pendingValidation);
  collect(cardsRes.pendingValidation);
  collect(usersRes.pendingValidation);
  collect(tagsRes.pendingValidation);

  const contacts = contactsRes.data;
  const panels = panelsRes.data;
  const cards = cardsRes.data;
  const users = usersRes.data;
  const settings = getSettings(accountId);

  /* --- Carrega mensagens de cada conversa -------------------------------- */
  // No modo simulado as mensagens ja vem embutidas; no modo real sao buscadas
  // por conversa, respeitando o rate limit do cliente HTTP.
  const conversations: ConversationSnapshot[] = await Promise.all(
    sessionsRes.data.map(async (session) => {
      if (session.messages.length > 0) return session;

      const messagesRes = await messagesAdapter.listBySession({
        accountId,
        sessionId: session.id,
      });
      collect(messagesRes.pendingValidation);
      return { ...session, messages: messagesRes.data };
    }),
  );

  /* --- Aplica filtros de periodo, equipe e vendedor ---------------------- */
  const periodFrom = Date.parse(filters.period.from);
  const periodTo = Date.parse(filters.period.to);

  const teamMemberIds = filters.teamId
    ? new Set(users.filter((u) => u.teamId === filters.teamId).map((u) => u.id))
    : null;

  const inScope = conversations.filter((conversation) => {
    const last = Date.parse(conversation.lastMessageAt);
    if (!Number.isFinite(last) || last < periodFrom || last > periodTo) return false;

    if (teamMemberIds && conversation.agentId && !teamMemberIds.has(conversation.agentId)) {
      return false;
    }
    if (filters.agentId && conversation.agentId !== filters.agentId) return false;

    return true;
  });

  /* --- Constroi as oportunidades ----------------------------------------- */
  const built: Opportunity[] = [];

  for (const conversation of inScope) {
    const contact = contacts.find((c) => c.id === conversation.contactId);
    const existingCard = cards.find(
      (card) =>
        card.sessionId === conversation.id ||
        (card.contactId === conversation.contactId && card.status === "OPEN"),
    );

    const previousCount = conversations.filter(
      (c) => c.contactId === conversation.contactId && c.id !== conversation.id,
    ).length;

    const opportunity = buildOpportunity({
      conversation,
      contact,
      existingCard,
      previousConversationCount: previousCount,
      panels,
      settings,
      now,
    });

    if (opportunity) built.push(opportunity);
  }

  /* --- Escopo de visibilidade e filtros finais --------------------------- */
  let opportunities = filterByVisibility(built, context);

  if (filters.priority) {
    opportunities = opportunities.filter((o) => o.priority === filters.priority);
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    opportunities = opportunities.filter(
      (o) =>
        o.contactName.toLowerCase().includes(needle) ||
        (o.company?.toLowerCase().includes(needle) ?? false) ||
        o.needSummary.toLowerCase().includes(needle),
    );
  }

  opportunities.sort(
    (a, b) => b.score - a.score || b.confidence - a.confidence || a.contactName.localeCompare(b.contactName),
  );

  /* --- Funil -------------------------------------------------------------- */
  const funnels = buildFunnels({ panels, cards, opportunities, now });

  /* --- Qualidade dos atendimentos ---------------------------------------- */
  const visibleAgentIds =
    context.visibleAgentIds === "ALL"
      ? [...new Set(inScope.map((c) => c.agentId).filter((id): id is string => Boolean(id)))]
      : context.visibleAgentIds;

  const opportunitySessionIds = new Set(opportunities.map((o) => o.sessionId));

  const qualityReports = visibleAgentIds
    .map((agentId) => {
      const user = users.find((u) => u.id === agentId);
      const agentConversations = inScope.filter((c) => c.agentId === agentId);
      if (agentConversations.length === 0) return null;

      return buildQualityReport({
        agentId,
        agentName: user?.name ?? agentId,
        teamName: user?.teamName,
        conversations: agentConversations,
        cards: cards.filter((c) => c.responsibleId === agentId),
        opportunitySessionIds: new Set(
          agentConversations.map((c) => c.id).filter((id) => opportunitySessionIds.has(id)),
        ),
      });
    })
    .filter((r): r is AgentQualityReport => r !== null)
    .sort((a, b) => b.overallScore - a.overallScore);

  /* --- Indicadores -------------------------------------------------------- */
  const contactsWithoutTags = contacts.filter((c) => c.tagIds.length === 0).length;

  const conversationsWithBuyingIntent = inScope.filter((conversation) =>
    detectSignals(conversation.messages).some((s) => s.polarity === "POSITIVE"),
  ).length;

  // "Recuperadas pela IA": oportunidades relevantes que NAO tinham card e que
  // estavam sem retorno — ou seja, que teriam passado despercebidas.
  const recoveredByAi = opportunities.filter(
    (o) => !o.cardId && o.hoursWithoutReply >= 24 && o.score >= 50,
  ).length;

  const kpis = computeKpis({
    opportunities,
    cards,
    panels,
    contactsWithoutTags,
    conversationsWithBuyingIntent,
    recoveredByAi,
    acceptanceRate: suggestionAcceptanceRate(accountId),
    now,
  });

  return {
    kpis,
    opportunities,
    funnels,
    qualityReports,
    recommendations: buildRecommendations({ opportunities, funnels, kpis, accountId }),
    settings,
    lastAnalysisAt: now.toISOString(),
    dataMode: shouldUseMock() ? "mock" : "live",
    pendingValidation: [...pending],
  };
}

/* ==========================================================================
   Funil
   ========================================================================== */
function buildFunnels(params: {
  panels: Panel[];
  cards: CrmCard[];
  opportunities: Opportunity[];
  now: Date;
}): FunnelSummary[] {
  const { panels, cards, opportunities, now } = params;

  return panels.map((panel) => {
    const panelCards = cards.filter((c) => c.panelId === panel.id);

    const steps: FunnelStepSummary[] = panel.steps.map((step) => {
      const stepCards = panelCards.filter((c) => c.stepId === step.id && c.status === "OPEN");

      return {
        stepId: step.id,
        stepName: step.name,
        order: step.order,
        cardCount: stepCards.length,
        totalValue: stepCards.reduce((acc, c) => acc + (c.amount ?? 0), 0),
        stalledCount: stepCards.filter(
          (c) => now.getTime() - Date.parse(c.updatedAt) > STALLED_DAYS * 24 * 36e5,
        ).length,
      };
    });

    const misplacedCards: MisplacedCard[] = [];

    for (const card of panelCards) {
      if (card.status !== "OPEN") continue;

      const opportunity = opportunities.find((o) => o.cardId === card.id);
      if (!opportunity?.recommendedStepName) continue;

      const currentStep = panel.steps.find((s) => s.id === card.stepId);
      if (!currentStep || currentStep.name === opportunity.recommendedStepName) continue;

      misplacedCards.push({
        cardId: card.id,
        title: card.title,
        currentStepName: currentStep.name,
        recommendedStepName: opportunity.recommendedStepName,
        reason:
          `A conversa indica ${opportunity.evidence
            .slice(0, 2)
            .map((e) => e.label.toLowerCase())
            .join(" e ") || "avanco comercial"}, compativel com a etapa recomendada.`,
        confidence: opportunity.confidence,
      });
    }

    return {
      panelId: panel.id,
      panelName: panel.name,
      panelType: panel.type,
      steps,
      misplacedCards,
    };
  });
}

/* ==========================================================================
   Recomendacoes
   ========================================================================== */
function buildRecommendations(params: {
  opportunities: Opportunity[];
  funnels: FunnelSummary[];
  kpis: IntelligenceKpis;
  accountId: string;
}): Recommendation[] {
  const { opportunities, funnels, kpis, accountId } = params;
  const out: Recommendation[] = [];

  const withoutReply = opportunities.filter((o) => o.hoursWithoutReply >= 24 && o.score >= 50);
  if (withoutReply.length > 0) {
    out.push({
      id: "rec_sem_retorno",
      accountId,
      title: "Responder clientes que ficaram sem retorno",
      description:
        `${withoutReply.length} cliente(s) com sinal de compra estao ha mais de 24h ` +
        `aguardando resposta. Este e o grupo com maior chance de recuperacao imediata.`,
      impact: "ALTO",
      effort: "BAIXO",
      category: "FOLLOWUP",
      affectedCount: withoutReply.length,
      evidenceSummary: `Score medio ${Math.round(
        withoutReply.reduce((a, o) => a + o.score, 0) / withoutReply.length,
      )}/100 no grupo.`,
      relatedOpportunityIds: withoutReply.slice(0, 10).map((o) => o.id),
    });
  }

  const unregistered = opportunities.filter((o) => !o.cardId && o.score >= 50);
  if (unregistered.length > 0) {
    out.push({
      id: "rec_sem_card",
      accountId,
      title: "Registrar oportunidades que nao estao no CRM",
      description:
        `${unregistered.length} oportunidade(s) relevante(s) existem apenas na conversa ` +
        `e nao tem card no funil. Sem registro, elas nao entram em nenhuma previsao.`,
      impact: "ALTO",
      effort: "BAIXO",
      category: "DADOS",
      affectedCount: unregistered.length,
      evidenceSummary: `Valor potencial somado: ${unregistered
        .reduce((a, o) => a + (o.estimatedValue ?? 0), 0)
        .toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`,
      relatedOpportunityIds: unregistered.slice(0, 10).map((o) => o.id),
    });
  }

  const misplaced = funnels.flatMap((f) => f.misplacedCards);
  if (misplaced.length > 0) {
    out.push({
      id: "rec_etapa_errada",
      accountId,
      title: "Corrigir cards que parecem estar na etapa errada",
      description:
        `${misplaced.length} card(s) estao em uma etapa que nao corresponde ao ` +
        `estagio real da conversa. Isso distorce a previsao de fechamento.`,
      impact: "MEDIO",
      effort: "BAIXO",
      category: "FUNIL",
      affectedCount: misplaced.length,
      evidenceSummary: misplaced
        .slice(0, 3)
        .map((c) => `${c.title}: ${c.currentStepName} -> ${c.recommendedStepName}`)
        .join(" | "),
      relatedOpportunityIds: [],
    });
  }

  const repurchase = opportunities.filter((o) => o.recommendedTagKeys.includes("RECOMPRA"));
  if (repurchase.length > 0) {
    out.push({
      id: "rec_recompra",
      accountId,
      title: "Trabalhar clientes em ciclo de recompra",
      description:
        `${repurchase.length} cliente(s) recorrente(s) sinalizaram reposicao. ` +
        `Costuma ser o ciclo de venda mais curto e com maior taxa de conversao.`,
      impact: "ALTO",
      effort: "BAIXO",
      category: "RECOMPRA",
      affectedCount: repurchase.length,
      evidenceSummary: repurchase.slice(0, 3).map((o) => o.contactName).join(", "),
      relatedOpportunityIds: repurchase.map((o) => o.id),
    });
  }

  if (kpis.contatosSemClassificacao > 0) {
    out.push({
      id: "rec_sem_classificacao",
      accountId,
      title: "Classificar contatos sem etiqueta",
      description:
        `${kpis.contatosSemClassificacao} contato(s) nao tem nenhuma etiqueta. ` +
        `Sem classificacao, eles ficam de fora de qualquer segmentacao ou campanha.`,
      impact: "MEDIO",
      effort: "BAIXO",
      category: "DADOS",
      affectedCount: kpis.contatosSemClassificacao,
      evidenceSummary: "Contagem apurada sobre a base de contatos da conta.",
      relatedOpportunityIds: [],
    });
  }

  const stalled = funnels
    .flatMap((f) => f.steps)
    .filter((s) => s.stalledCount > 0)
    .sort((a, b) => b.stalledCount - a.stalledCount);

  if (stalled.length > 0 && stalled[0]) {
    const worst = stalled[0];
    out.push({
      id: "rec_etapa_represada",
      accountId,
      title: `Destravar a etapa "${worst.stepName}"`,
      description:
        `${worst.stalledCount} card(s) estao parados ha mais de ${STALLED_DAYS} dias nesta etapa, ` +
        `somando ${worst.totalValue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}. ` +
        `E onde o funil esta represando mais valor.`,
      impact: "ALTO",
      effort: "MEDIO",
      category: "FUNIL",
      affectedCount: worst.stalledCount,
      evidenceSummary: `Etapa com maior numero de cards sem movimentacao.`,
      relatedOpportunityIds: [],
    });
  }

  const impactOrder = { ALTO: 0, MEDIO: 1, BAIXO: 2 } as const;
  return out.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact]);
}
