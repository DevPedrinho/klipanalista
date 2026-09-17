import "server-only";
import type { ActionType, Priority } from "@/domain/enums";
import type {
  ContactSnapshot,
  ConversationSnapshot,
  CrmCard,
  IntegrationSettings,
  IntelligenceKpis,
  Opportunity,
  Panel,
  PanelStep,
  SuggestedAction,
  TenantContext,
} from "@/domain/types";
import { maskPhone } from "@/server/security/masking";
import { computeScore, SCORE_DISPLAY_THRESHOLD } from "@/server/scoring/score";
import { detectObjections } from "@/server/scoring/signals";
import { ACTION_LABELS, requiresHumanConfirmation } from "./automation.service";
import { recommendTagKeys } from "./tag-taxonomy.service";

/**
 * Monta oportunidades a partir de conversas, contatos e cards.
 *
 * Este servico NAO chama a API: recebe os snapshots ja carregados pelos
 * adapters. Isso mantem o motor testavel e independente da integracao.
 */

export interface BuildInput {
  conversation: ConversationSnapshot;
  contact?: ContactSnapshot;
  existingCard?: CrmCard;
  previousConversationCount: number;
  panels: Panel[];
  settings: IntegrationSettings;
  now?: Date;
}

/* --------------------------------------------------------------------------
   Resumo da necessidade a partir das mensagens do cliente
   -------------------------------------------------------------------------- */
function summarizeNeed(conversation: ConversationSnapshot): string {
  const inbound = conversation.messages.filter((m) => m.direction === "INBOUND");
  if (inbound.length === 0) return "Sem mensagens do cliente nesta conversa.";

  // A primeira mensagem do cliente costuma conter o pedido original.
  const first = inbound[0]?.text.trim() ?? "";
  const last = inbound[inbound.length - 1]?.text.trim() ?? "";

  const summary = inbound.length === 1 ? first : `${first} | Ultimo contato: ${last}`;
  return summary.length > 320 ? `${summary.slice(0, 317)}...` : summary;
}

/* --------------------------------------------------------------------------
   Produto de interesse: extrai substantivos de produto citados pelo cliente
   -------------------------------------------------------------------------- */
const PRODUCT_HINTS = [
  /\b(\d+\s*(?:metros?|m|toneladas?|t|unidades?|un|pe[çc]as?|litros?|kg))\s+de\s+([\wçãõáéíóúâêô\s]{3,40})/i,
  /\b(?:or[çc]amento|cota[çc][ãa]o|valor|pre[çc]o)\s+(?:para|de|do|da)\s+([\wçãõáéíóúâêô\s]{3,40})/i,
  /\b(?:preciso|quero|comprar|adquirir)\s+(?:de\s+)?([\wçãõáéíóúâêô\s]{3,40})/i,
  /\b(?:quanto\s+custa|valor\s+d[oa])\s+(?:o\s+|a\s+|um\s+|uma\s+)?([\wçãõáéíóúâêô\s]{3,40})/i,
];

/**
 * Termos que descrevem o PEDIDO, nao o produto. Capturar "uma cotacao" como
 * produto de interesse seria pior do que nao capturar nada.
 */
const FILLER_TERMS =
  /^(uma?\s+)?(cota[çc][ãa]o|or[çc]amento|proposta|informa[çc][õo]es?|detalhes?|ajuda|contato|aten[çc][ãa]o|retorno|valores?|pre[çc]os?)\b/i;

/** Artigos e pronomes iniciais que nao agregam ao nome do produto. */
const LEADING_ARTICLES = /^(o|a|os|as|um|uma|uns|umas|de|do|da|dos|das)\s+/i;

function cleanProductTerm(raw: string): string | undefined {
  // Corta na primeira pontuacao ou conjuncao, para nao arrastar a frase toda.
  let clean = raw.split(/[,.;!?]|\s+(?:para|porque|e\s+preciso|pois)\s+/i)[0]?.trim() ?? "";

  // Remove artigos iniciais repetidamente ("de uma chapa" -> "chapa").
  let previous: string;
  do {
    previous = clean;
    clean = clean.replace(LEADING_ARTICLES, "").trim();
  } while (clean !== previous);

  if (clean.length < 3) return undefined;
  if (FILLER_TERMS.test(clean)) return undefined;

  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

function extractProductInterest(conversation: ConversationSnapshot): string | undefined {
  for (const message of conversation.messages) {
    if (message.direction !== "INBOUND") continue;

    for (const pattern of PRODUCT_HINTS) {
      const match = pattern.exec(message.text);
      if (!match) continue;

      // O grupo 2 existe nos padroes com quantidade; senao usa o grupo 1.
      const captured = (match[2] ?? match[1] ?? "").trim();
      if (captured.length < 3) continue;

      const clean = cleanProductTerm(captured);
      if (clean) return clean;
    }
  }
  return undefined;
}

/* --------------------------------------------------------------------------
   Valor potencial estimado
   -------------------------------------------------------------------------- */
function extractStatedValue(conversation: ConversationSnapshot): number | undefined {
  // Procura valores em reais citados na conversa (proposta enviada, etc.).
  const pattern = /R\$\s*([\d.]+(?:,\d{2})?)/g;
  let best: number | undefined;

  for (const message of conversation.messages) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(message.text)) !== null) {
      const raw = match[1];
      if (!raw) continue;

      const value = Number(raw.replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(value) && value > 0) {
        best = best === undefined ? value : Math.max(best, value);
      }
    }
  }
  return best;
}

/* --------------------------------------------------------------------------
   Proxima acao recomendada
   -------------------------------------------------------------------------- */
function recommendNextAction(params: {
  priority: Priority;
  hoursWithoutReply: number;
  signalCodes: string[];
  hasOpenCard: boolean;
  lastMessageFromContact: boolean;
}): string {
  const has = (code: string) => params.signalCodes.includes(code);

  if (params.lastMessageFromContact && params.hoursWithoutReply >= 24) {
    return (
      "Responder o cliente hoje: ele fez a ultima pergunta e esta sem retorno ha " +
      `${Math.floor(params.hoursWithoutReply / 24)} dia(s).`
    );
  }
  if (has("ORCAMENTO_APROVADO")) {
    return "Enviar a proposta formal e confirmar prazo de entrega: o orcamento ja foi aprovado do lado do cliente.";
  }
  if (has("PEDIDO_DESCONTO")) {
    return "Apresentar contraproposta com condicao de pagamento alternativa antes de ceder desconto direto.";
  }
  if (has("PRAZO_DECISAO")) {
    return "Confirmar a data limite do cliente e alinhar internamente se o prazo e viavel.";
  }
  if (has("RECOMPRA")) {
    return "Enviar o valor atualizado do ultimo pedido e confirmar quantidade para reposicao.";
  }
  if (has("PEDIDO_VENDEDOR")) {
    return "Agendar contato telefonico: o cliente pediu explicitamente para falar com um vendedor.";
  }
  if (!params.hasOpenCard && params.priority !== "BAIXA") {
    return "Registrar a oportunidade no CRM e definir o proximo passo com data.";
  }
  return "Retomar o contato e qualificar necessidade, prazo e orcamento.";
}

/* --------------------------------------------------------------------------
   Mensagem de follow-up sugerida
   -------------------------------------------------------------------------- */
function buildFollowUpMessage(params: {
  contactName: string;
  agentName?: string;
  productInterest?: string;
  signalCodes: string[];
  hoursWithoutReply: number;
}): string {
  const firstName = params.contactName.split(/\s+/)[0] ?? params.contactName;
  const produto = params.productInterest ? ` sobre ${params.productInterest}` : "";
  const assinatura = params.agentName ? `\n\n${params.agentName}` : "";
  const has = (code: string) => params.signalCodes.includes(code);

  if (has("ORCAMENTO_APROVADO")) {
    return (
      `Ola, ${firstName}! Tudo bem?\n\n` +
      `Como o orcamento ja foi aprovado do seu lado, preparei a proposta formal${produto} ` +
      `para seguirmos. Posso te enviar agora para conferencia?\n\n` +
      `Se preferir, consigo ja reservar o prazo de entrega para a data que voce precisa.` +
      assinatura
    );
  }

  if (has("PEDIDO_DESCONTO")) {
    return (
      `Ola, ${firstName}! Tudo bem?\n\n` +
      `Levei sua colocacao sobre o valor${produto} para analise interna. ` +
      `Consigo trabalhar uma condicao melhor ajustando a forma de pagamento. ` +
      `Podemos conversar hoje para eu te apresentar as opcoes?` +
      assinatura
    );
  }

  if (has("RECOMPRA")) {
    return (
      `Ola, ${firstName}! Tudo bem?\n\n` +
      `Separei o valor atualizado${produto} para a reposicao. ` +
      `Confirma a quantidade que voce precisa para eu ja deixar o pedido pronto?` +
      assinatura
    );
  }

  const dias = Math.floor(params.hoursWithoutReply / 24);
  const tempo = dias >= 1 ? ` Vi que nossa ultima conversa foi ha ${dias} dia(s).` : "";

  return (
    `Ola, ${firstName}! Tudo bem?${tempo}\n\n` +
    `Passando para retomar nosso contato${produto}. ` +
    `Ainda faz sentido para voce seguirmos com isso?\n\n` +
    `Se quiser, posso te enviar os detalhes atualizados hoje mesmo.` +
    assinatura
  );
}

/* --------------------------------------------------------------------------
   Etapa recomendada do funil
   -------------------------------------------------------------------------- */
/**
 * Estagios comerciais, do mais frio ao mais quente. Sao um conceito NOSSO:
 * servem para traduzir a leitura da conversa em uma posicao no funil, seja
 * qual for o nome que a empresa deu as proprias etapas.
 */
export const ESTAGIOS_COMERCIAIS = [
  "TRIAGEM",
  "QUALIFICACAO",
  "PROPOSTA",
  "NEGOCIACAO",
] as const;

export type EstagioComercial = (typeof ESTAGIOS_COMERCIAIS)[number];

/**
 * Vocabulario de nomes de etapa por estagio.
 *
 * Cada empresa batiza o proprio funil. A versao anterior procurava apenas
 * "qualifica", "proposta" e "negocia" e devolvia `undefined` em funis reais
 * como "Proposta Quente / Visita / Stand By / Ordem de Compra / Entregue" —
 * ou seja, a oportunidade mais quente era justamente a que ficava sem
 * recomendacao de etapa. O vocabulario cobre os termos mais comuns no
 * mercado brasileiro e, quando nenhum casa, a posicao no funil decide.
 *
 * Sobrescritivel por conta em FLW_FUNNEL_<ESTAGIO> (lista separada por
 * virgulas), para funis com nomenclatura propria.
 */
const VOCABULARIO_PADRAO: Record<EstagioComercial, string[]> = {
  TRIAGEM: ["triagem", "novo", "novos", "lead", "entrada", "prospec", "primeiro contato"],
  QUALIFICACAO: ["qualifica", "diagnost", "descoberta", "levantamento", "sondagem", "interesse"],
  PROPOSTA: ["proposta", "orcamento", "orçamento", "cotacao", "cotação", "apresenta", "visita", "demonstra", "reuniao", "reunião"],
  NEGOCIACAO: ["negocia", "fechamento", "ordem de compra", "pedido", "contrato", "assinatura"],
};

function vocabularioDe(estagio: EstagioComercial): string[] {
  const override = process.env[`FLW_FUNNEL_${estagio}`];
  if (!override) return VOCABULARIO_PADRAO[estagio];

  const termos = override
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return termos.length > 0 ? termos : VOCABULARIO_PADRAO[estagio];
}

/** Posicao relativa de cada estagio no funil, usada quando nenhum nome casa. */
const POSICAO_RELATIVA: Record<EstagioComercial, number> = {
  TRIAGEM: 0,
  QUALIFICACAO: 0.34,
  PROPOSTA: 0.67,
  NEGOCIACAO: 1,
};

/** Le a conversa e diz ate onde no funil ela justifica avancar. */
export function estagioSugerido(params: {
  signalCodes: string[];
  score: number;
}): EstagioComercial {
  const has = (code: string) => params.signalCodes.includes(code);

  if (has("PEDIDO_DESCONTO") || has("ORCAMENTO_APROVADO")) return "NEGOCIACAO";
  if (has("SOLICITACAO_PRECO") || has("ENVIOU_ESPECIFICACAO") || has("PROPOSTA_ENVIADA")) {
    return "PROPOSTA";
  }
  if (params.score >= 50) return "QUALIFICACAO";

  return "TRIAGEM";
}

/**
 * Mapeia os quatro estagios comerciais nas etapas REAIS do funil da conta.
 *
 * O mapa inteiro e calculado de uma vez, e nao um estagio por vez, porque so
 * assim da para garantir a propriedade que importa: um estagio mais quente
 * nunca pode recomendar uma etapa ANTERIOR a de um estagio mais frio. Quando
 * cada estagio decidia sozinho, um funil como "Proposta Quente / Visita /
 * Stand By / Ordem de Compra" produzia a sequencia 1 -> 2 -> 1 -> 4: o nome
 * casava em PROPOSTA (etapa 1) enquanto QUALIFICACAO caia na posicao 2.
 *
 * Como funciona:
 *  1. cada estagio procura uma ancora — a primeira etapa aberta cujo nome
 *     bate com o vocabulario daquele estagio;
 *  2. os estagios sem ancora recebem um palpite pela posicao no funil;
 *  3. ancora e palpite sao limitados a janela [anterior, proxima ancora],
 *     o que torna a sequencia nao decrescente por construcao.
 *
 * Etapas de desfecho (`phase === "FINAL"`, ganho/perda) ficam de fora: marcar
 * um negocio como ganho ou perdido e decisao de pessoa, nunca de leitura de
 * conversa.
 */
export function mapearFunil(steps: PanelStep[]): Record<EstagioComercial, PanelStep> | null {
  const abertas = [...steps]
    .filter((s) => s.phase !== "FINAL")
    .sort((a, b) => a.order - b.order);

  if (abertas.length === 0) return null;

  const ultimo = abertas.length - 1;

  const ancoras = ESTAGIOS_COMERCIAIS.map((estagio) => {
    const termos = vocabularioDe(estagio);
    const indice = abertas.findIndex((step) => {
      const nome = step.name.toLowerCase();
      return termos.some((termo) => nome.includes(termo));
    });
    return indice >= 0 ? indice : undefined;
  });

  const mapa = {} as Record<EstagioComercial, PanelStep>;
  let piso = 0;

  ESTAGIOS_COMERCIAIS.forEach((estagio, i) => {
    // Teto: a proxima ancora a frente. Passar dela invadiria um estagio mais
    // quente que a conversa ainda nao justifica.
    const proximaAncora = ancoras.slice(i + 1).find((a) => a !== undefined);
    const teto = Math.max(piso, proximaAncora ?? ultimo);

    const palpite = ancoras[i] ?? Math.round(POSICAO_RELATIVA[estagio] * ultimo);
    const escolhido = Math.min(teto, Math.max(piso, palpite));

    // `abertas` nao e vazio e o indice esta limitado a [0, ultimo].
    mapa[estagio] = abertas[escolhido] as PanelStep;
    piso = escolhido;
  });

  return mapa;
}

/**
 * Traduz o estagio sugerido em uma etapa REAL do funil da conta.
 *
 * So devolve `undefined` quando o funil nao tem nenhuma etapa aberta. Um nome
 * fora do vocabulario nunca impede a recomendacao.
 */
export function recomendarEtapa(params: {
  steps: PanelStep[];
  estagio: EstagioComercial;
}): PanelStep | undefined {
  return mapearFunil(params.steps)?.[params.estagio];
}

function recommendStep(params: {
  panels: Panel[];
  signalCodes: string[];
  score: number;
}): string | undefined {
  const sales = params.panels.find((p) => p.type === "SALES");
  if (!sales) return undefined;

  const estagio = estagioSugerido({
    signalCodes: params.signalCodes,
    score: params.score,
  });

  return recomendarEtapa({ steps: sales.steps, estagio })?.name;
}

/* --------------------------------------------------------------------------
   Acoes sugeridas
   -------------------------------------------------------------------------- */
let actionSeq = 0;

function buildActions(params: {
  opportunityId: string;
  hasOpenCard: boolean;
  cardId?: string;
  sessionId: string;
  contactId: string;
  settings: IntegrationSettings;
  recommendedStepName?: string;
  estimatedValue?: number;
  tagKeys: string[];
}): SuggestedAction[] {
  const make = (
    type: ActionType,
    description: string,
    payloadPreview: Record<string, unknown>,
  ): SuggestedAction => {
    actionSeq += 1;
    return {
      id: `act_${params.opportunityId}_${actionSeq}`,
      type,
      label: ACTION_LABELS[type],
      description,
      requiresHumanConfirmation: requiresHumanConfirmation(type, params.settings),
      status: "SUGERIDA",
      payloadPreview,
    };
  };

  const actions: SuggestedAction[] = [];

  if (params.hasOpenCard && params.cardId) {
    actions.push(
      make("ATUALIZAR_CARD", "Atualizar o card existente com o contexto mais recente da conversa.", {
        cardId: params.cardId,
        stepName: params.recommendedStepName,
        amount: params.estimatedValue,
      }),
    );
  } else {
    actions.push(
      make("CRIAR_CARD", "Criar a oportunidade no funil de vendas, vinculada a este atendimento.", {
        sessionId: params.sessionId,
        contactId: params.contactId,
        stepName: params.recommendedStepName,
        amount: params.estimatedValue,
      }),
    );
  }

  if (params.tagKeys.length > 0) {
    actions.push(
      make("APLICAR_ETIQUETAS", "Aplicar as etiquetas da taxonomia da IA ao contato.", {
        contactId: params.contactId,
        tagKeys: params.tagKeys,
      }),
    );
  }

  actions.push(
    make("ATRIBUIR_RESPONSAVEL", "Definir quem vai conduzir esta oportunidade.", {
      sessionId: params.sessionId,
    }),
    make("DEFINIR_FOLLOWUP", "Agendar a data do proximo contato.", {
      sessionId: params.sessionId,
    }),
    make("CRIAR_NOTA", "Registrar a analise da IA como nota interna do atendimento.", {
      sessionId: params.sessionId,
    }),
    make("MARCAR_ANALISADA", "Marcar esta oportunidade como ja revisada.", {
      opportunityId: params.opportunityId,
    }),
    make("IGNORAR_RECOMENDACAO", "Descartar esta recomendacao e ensinar a IA a nao repeti-la.", {
      opportunityId: params.opportunityId,
    }),
  );

  return actions;
}

/* --------------------------------------------------------------------------
   Construcao da oportunidade
   -------------------------------------------------------------------------- */
export function buildOpportunity(input: BuildInput): Opportunity | null {
  const now = input.now ?? new Date();
  const { conversation, contact, existingCard, panels, settings } = input;

  const scoreResult = computeScore(
    {
      conversation,
      existingCard,
      previousConversationCount: input.previousConversationCount,
      now,
    },
    {
      hasName: Boolean(contact?.name),
      hasPhone: Boolean(contact?.phone),
      hasCompany: Boolean(contact?.company),
      hasEmail: Boolean(contact?.email),
      hasAgent: Boolean(conversation.agentId),
    },
  );

  // Regra do produto: abaixo de 30 nao e exibida como oportunidade principal.
  if (scoreResult.belowThreshold) return null;

  const lastMessage = conversation.messages[conversation.messages.length - 1];
  const lastMessageFromContact = lastMessage?.direction === "INBOUND";
  const hoursWithoutReply = Math.floor(
    (now.getTime() - new Date(conversation.lastMessageAt).getTime()) / 36e5,
  );

  const signalCodes = scoreResult.signals.map((s) => s.code);
  const hasOpenCard = existingCard?.status === "OPEN";

  const tagKeys = recommendTagKeys({
    score: scoreResult.score,
    confidence: scoreResult.confidence,
    hoursWithoutReply,
    signalCodes,
    hasOpenCard: Boolean(hasOpenCard),
    lastMessageFromContact: Boolean(lastMessageFromContact),
  });

  const statedValue = extractStatedValue(conversation);
  const estimatedValue = existingCard?.amount ?? statedValue;
  const productInterest = extractProductInterest(conversation);
  const opportunityId = `opp_${conversation.id}`;

  const currentStepName = existingCard
    ? panels
        .find((p) => p.id === existingCard.panelId)
        ?.steps.find((s) => s.id === existingCard.stepId)?.name
    : undefined;

  return {
    id: opportunityId,
    accountId: conversation.accountId,

    contactId: conversation.contactId,
    contactName: contact?.name ?? "Contato sem nome",
    contactPhoneMasked: maskPhone(contact?.phone),
    company: contact?.company,

    channel: conversation.channel,
    sessionId: conversation.id,
    agentId: conversation.agentId,
    agentName: conversation.agentName,

    productInterest,
    needSummary: summarizeNeed(conversation),

    lastInteractionAt: conversation.lastMessageAt,
    hoursWithoutReply,

    currentPanelId: existingCard?.panelId,
    currentStepId: existingCard?.stepId,
    currentStepName,
    cardId: existingCard?.id,

    estimatedValue,
    // Marcado como inferido sempre que nao veio de um card confirmado.
    estimatedValueIsInferred: existingCard?.amount === undefined && statedValue !== undefined,

    score: scoreResult.score,
    confidence: scoreResult.confidence,
    priority: scoreResult.priority,
    scoreBreakdown: scoreResult.breakdown,

    reason: scoreResult.rationale[0] ?? "Sinais comerciais identificados na conversa.",
    evidence: scoreResult.signals,
    objections: detectObjections(conversation.messages),

    nextAction: recommendNextAction({
      priority: scoreResult.priority,
      hoursWithoutReply,
      signalCodes,
      hasOpenCard: Boolean(hasOpenCard),
      lastMessageFromContact: Boolean(lastMessageFromContact),
    }),
    suggestedFollowUpMessage: buildFollowUpMessage({
      contactName: contact?.name ?? "cliente",
      agentName: conversation.agentName,
      productInterest,
      signalCodes,
      hoursWithoutReply,
    }),
    recommendedTagKeys: tagKeys,
    recommendedStepName: recommendStep({ panels, signalCodes, score: scoreResult.score }),

    state: "NOVA",
    analyzedAt: now.toISOString(),
    actions: buildActions({
      opportunityId,
      hasOpenCard: Boolean(hasOpenCard),
      cardId: existingCard?.id,
      sessionId: conversation.id,
      contactId: conversation.contactId,
      settings,
      recommendedStepName: recommendStep({ panels, signalCodes, score: scoreResult.score }),
      estimatedValue,
      tagKeys,
    }),
  };
}

/* --------------------------------------------------------------------------
   Filtro por permissao
   -------------------------------------------------------------------------- */
/**
 * Vendedores enxergam apenas os proprios atendimentos. Gestores e admins
 * enxergam a equipe. Aplicado no servidor, nunca no cliente.
 */
export function filterByVisibility(
  opportunities: Opportunity[],
  context: TenantContext,
): Opportunity[] {
  const scoped = opportunities.filter((o) => o.accountId === context.accountId);
  if (context.visibleAgentIds === "ALL") return scoped;

  const allowed = new Set(context.visibleAgentIds);
  return scoped.filter((o) => !o.agentId || allowed.has(o.agentId));
}

/* --------------------------------------------------------------------------
   Indicadores
   -------------------------------------------------------------------------- */
export function computeKpis(params: {
  opportunities: Opportunity[];
  cards: CrmCard[];
  panels: Panel[];
  contactsWithoutTags: number;
  conversationsWithBuyingIntent: number;
  recoveredByAi: number;
  acceptanceRate: number;
  now?: Date;
}): IntelligenceKpis {
  const { opportunities } = params;

  const misplaced = countMisplacedCards(params.cards, params.panels, opportunities);

  return {
    oportunidadesEncontradas: opportunities.length,
    oportunidadesAltaPrioridade: opportunities.filter(
      (o) => o.priority === "ALTA" || o.priority === "CRITICA",
    ).length,
    valorPotencialEstimado: opportunities.reduce((acc, o) => acc + (o.estimatedValue ?? 0), 0),
    clientesSemRetorno: opportunities.filter((o) => o.hoursWithoutReply >= 24).length,
    oportunidadesParadas: opportunities.filter((o) => o.hoursWithoutReply >= 24 * 7).length,
    cardsEtapaProvavelmenteErrada: misplaced,
    contatosSemClassificacao: params.contactsWithoutTags,
    atendimentosComIntencaoCompra: params.conversationsWithBuyingIntent,
    oportunidadesRecuperadasPelaIa: params.recoveredByAi,
    taxaAproveitamentoSugestoes: params.acceptanceRate,
  };
}

/** Cards cuja etapa atual diverge da etapa recomendada pela analise. */
export function countMisplacedCards(
  cards: CrmCard[],
  panels: Panel[],
  opportunities: Opportunity[],
): number {
  let count = 0;

  for (const card of cards) {
    if (card.status !== "OPEN") continue;

    const opportunity = opportunities.find((o) => o.cardId === card.id);
    if (!opportunity?.recommendedStepName) continue;

    const panel = panels.find((p) => p.id === card.panelId);
    const currentStep = panel?.steps.find((s) => s.id === card.stepId);
    if (!currentStep) continue;

    if (currentStep.name !== opportunity.recommendedStepName) count += 1;
  }
  return count;
}

export { SCORE_DISPLAY_THRESHOLD };
