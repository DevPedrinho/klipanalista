import type {
  ActionStatus,
  ActionType,
  AutomationMode,
  CardStatus,
  Channel,
  OpportunityState,
  PanelType,
  Priority,
  UserRole,
  WebhookEvent,
  WidgetOrigin,
} from "./enums";

/* ==========================================================================
   Contexto de tenant e usuario
   ========================================================================== */

/**
 * Contexto validado de uma requisicao. Toda leitura e escrita do modulo
 * acontece dentro de um TenantContext: nao existe consulta sem accountId.
 */
export interface TenantContext {
  accountId: string;
  userId: string;
  role: UserRole;
  /** Vendedores so enxergam os proprios atendimentos; gestores, a equipe. */
  visibleAgentIds: string[] | "ALL";
  teamId?: string;
}

export interface AppUser {
  id: string;
  accountId: string;
  name: string;
  email?: string;
  role: UserRole;
  /** Equipe principal: a primeira de `teamIds`. */
  teamId?: string;
  /**
   * Todas as equipes do usuario. A API devolve `departments` como lista —
   * um atendente pode estar em mais de um departamento.
   */
  teamIds?: string[];
  teamName?: string;
  active: boolean;
}

export interface Team {
  id: string;
  accountId: string;
  name: string;
  memberIds: string[];
}

/* ==========================================================================
   Filtros
   ========================================================================== */

export type PeriodPreset = "7d" | "15d" | "30d" | "90d" | "custom";

export interface PeriodFilter {
  preset: PeriodPreset;
  /** ISO 8601. Inclusivo. */
  from: string;
  /** ISO 8601. Inclusivo. */
  to: string;
}

export interface IntelligenceFilters {
  period: PeriodFilter;
  teamId?: string;
  agentId?: string;
  priority?: Priority;
  search?: string;
}

/* ==========================================================================
   Snapshots de dados vindos da plataforma
   ========================================================================== */

export interface ContactSnapshot {
  id: string;
  accountId: string;
  name: string;
  /** Sempre armazenado mascarado fora do backend. */
  phone?: string;
  email?: string;
  company?: string;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MessageSnapshot {
  id: string;
  sessionId: string;
  /** Quem enviou: o cliente ou a equipe. */
  direction: "INBOUND" | "OUTBOUND";
  authorName?: string;
  text: string;
  sentAt: string;
  /** Anexos: apenas metadados, nunca o conteudo. */
  attachments?: { type: string; name?: string }[];
}

export interface ConversationSnapshot {
  id: string;
  accountId: string;
  contactId: string;
  channel: Channel;
  agentId?: string;
  agentName?: string;
  status: "OPEN" | "CLOSED" | "PENDING";
  startedAt: string;
  lastMessageAt: string;

  /**
   * Campos que a propria listagem de conversas ja traz (CONFIRMADOS no
   * payload real de GET /chat/v2/session). Poder ler a recencia sem baixar
   * todas as mensagens evita uma chamada por conversa.
   */
  /** Ultima mensagem recebida DO cliente. */
  lastInboundAt?: string;
  /** Ultima mensagem enviada AO cliente. */
  lastOutboundAt?: string;
  /** Quando o atendente respondeu pela primeira vez. */
  firstResponseAt?: string;
  /** Segundos que o cliente esperou pelo primeiro atendimento. */
  waitSeconds?: number;
  /** Duracao do atendimento em segundos. */
  serviceSeconds?: number;
  /**
   * Link de visualizacao do atendimento devolvido pela propria API.
   * Usado pela acao "Abrir atendimento" quando disponivel.
   */
  previewUrl?: string;

  messages: MessageSnapshot[];
}

/* ==========================================================================
   CRM
   ========================================================================== */

/**
 * Fase da etapa no funil, conforme a API.
 * CONFIRMADO no contrato de card: `stepPhase` e um enum NONE | INITIAL | FINAL.
 * Na tela de edicao do painel aparece como Inicial / Intermediario / Final.
 */
export type StepPhase = "NONE" | "INITIAL" | "FINAL";

export interface PanelStep {
  id: string;
  name: string;
  order: number;
  /** NONE = intermediaria. INITIAL = entrada do funil. FINAL = desfecho. */
  phase?: StepPhase;
  /** Etapa usada para triagem automatica no modo AUTOMATICO_CONTROLADO. */
  isTriage?: boolean;
}

export interface Panel {
  id: string;
  accountId: string;
  name: string;
  type: PanelType;
  steps: PanelStep[];
}

export interface CrmCard {
  id: string;
  accountId: string;
  panelId: string;
  /** Titulo do painel, quando a resposta o traz. */
  panelTitle?: string;
  stepId: string;
  /** Titulo da etapa, vindo da propria resposta do card. */
  stepName?: string;
  stepPhase?: StepPhase;
  title: string;

  /**
   * Um card pode referenciar VARIOS contatos: o campo da API e `contactIds`.
   * Guardamos a lista inteira; `contactId` e apenas atalho para o primeiro.
   */
  contactIds: string[];
  contactId?: string;

  sessionId?: string;
  /** API: `responsibleUserId`. */
  responsibleId?: string;
  responsibleName?: string;
  /** API: `monetaryAmount`. */
  amount?: number;
  description?: string;
  dueDate?: string;
  /** A propria API calcula se o vencimento passou. */
  isOverdue?: boolean;
  status: CardStatus;
  /** Preenchido quando o card esta LOST. */
  lostReasonId?: string;
  lostReasonName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LossReason {
  id: string;
  name: string;
}

export interface CardNote {
  id: string;
  cardId: string;
  text: string;
  authorId: string;
  createdAt: string;
}

/* ==========================================================================
   Etiquetas
   ========================================================================== */

export interface Tag {
  id: string;
  accountId: string;
  name: string;
  color?: string;
}

/** Entrada da taxonomia curada da IA. */
export interface TaxonomyTag {
  /** Chave estavel interna, independente do id da plataforma. */
  key: string;
  /** Nome canonico exibido, ex.: "IA | Oportunidade quente". */
  name: string;
  description: string;
  /** Regra que justifica a aplicacao. Registrada na auditoria. */
  rule: string;
  color: string;
  /** Id correspondente na plataforma, quando ja existir. */
  platformTagId?: string;
  /** Sinonimos aceitos ao procurar uma etiqueta equivalente ja existente. */
  synonyms: string[];
}

export interface TagResolution {
  key: string;
  canonicalName: string;
  /** Etiqueta existente reutilizada, quando encontrada. */
  matched?: Tag;
  /** Como a etiqueta foi resolvida. */
  outcome: "REUSE_EXACT" | "REUSE_SYNONYM" | "NEEDS_APPROVAL";
  rule: string;
}

/* ==========================================================================
   Score e evidencias
   ========================================================================== */

export type SignalPolarity = "POSITIVE" | "NEGATIVE";

export interface DetectedSignal {
  /** Identificador estavel do sinal, ex.: "SOLICITACAO_PRECO". */
  code: string;
  label: string;
  polarity: SignalPolarity;
  /** Trecho literal da conversa que disparou o sinal. */
  excerpt: string;
  messageId: string;
  sentAt: string;
  /** 0 a 1. Quao forte o trecho sustenta o sinal. */
  strength: number;
}

export interface ScoreBreakdown {
  intencaoExplicita: number;
  recencia: number;
  clarezaNecessidade: number;
  maturidadeComercial: number;
  proximoPasso: number;
  relacionamento: number;
  qualidadeDados: number;
}

export const SCORE_WEIGHTS: Readonly<Record<keyof ScoreBreakdown, number>> = {
  intencaoExplicita: 30,
  recencia: 15,
  clarezaNecessidade: 15,
  maturidadeComercial: 15,
  proximoPasso: 10,
  relacionamento: 10,
  qualidadeDados: 5,
};

export interface ScoreResult {
  /** 0 a 100. */
  score: number;
  breakdown: ScoreBreakdown;
  /** 0 a 100. Quantidade e qualidade das evidencias, nao o potencial de venda. */
  confidence: number;
  priority: Priority;
  /** true quando o score ficou abaixo do corte de exibicao (30). */
  belowThreshold: boolean;
  signals: DetectedSignal[];
  /** Explicacao legivel de por que a oportunidade foi classificada assim. */
  rationale: string[];
  /** Sinais negativos que suprimiram a oportunidade. */
  disqualifiers: DetectedSignal[];
}

/* ==========================================================================
   Oportunidade
   ========================================================================== */

export interface SuggestedAction {
  id: string;
  type: ActionType;
  label: string;
  description: string;
  /** Acoes irreversiveis ou sensiveis exigem confirmacao humana sempre. */
  requiresHumanConfirmation: boolean;
  status: ActionStatus;
  /** Dados que seriam enviados a API. Nunca executados na primeira entrega. */
  payloadPreview: Record<string, unknown>;
}

export interface Opportunity {
  id: string;
  accountId: string;

  contactId: string;
  contactName: string;
  /** Mascarado antes de sair do servidor. */
  contactPhoneMasked?: string;
  company?: string;

  channel: Channel;
  sessionId: string;
  agentId?: string;
  agentName?: string;

  productInterest?: string;
  needSummary: string;

  lastInteractionAt: string;
  /** Horas inteiras desde a ultima mensagem do cliente. */
  hoursWithoutReply: number;

  currentPanelId?: string;
  currentStepId?: string;
  currentStepName?: string;
  cardId?: string;

  estimatedValue?: number;
  /** Marca que o valor foi inferido pela IA e nao confirmado por humano. */
  estimatedValueIsInferred: boolean;

  score: number;
  confidence: number;
  priority: Priority;
  scoreBreakdown: ScoreBreakdown;

  reason: string;
  evidence: DetectedSignal[];
  objections: string[];

  nextAction: string;
  suggestedFollowUpMessage: string;
  recommendedTagKeys: string[];
  recommendedStepName?: string;

  state: OpportunityState;
  analyzedAt: string;
  actions: SuggestedAction[];
}

/* ==========================================================================
   Indicadores
   ========================================================================== */

export interface IntelligenceKpis {
  oportunidadesEncontradas: number;
  oportunidadesAltaPrioridade: number;
  valorPotencialEstimado: number;
  clientesSemRetorno: number;
  oportunidadesParadas: number;
  cardsEtapaProvavelmenteErrada: number;
  contatosSemClassificacao: number;
  atendimentosComIntencaoCompra: number;
  oportunidadesRecuperadasPelaIa: number;
  /** Percentual 0-100 de sugestoes aceitas. */
  taxaAproveitamentoSugestoes: number;
}

/* ==========================================================================
   Qualidade do atendimento
   ========================================================================== */

export interface QualityCriterion {
  key: string;
  label: string;
  /** 0 a 100. */
  score: number;
  /** Observacao orientativa, nunca punitiva. */
  note: string;
  status: "BOM" | "ATENCAO" | "CRITICO";
}

export interface AgentQualityReport {
  agentId: string;
  agentName: string;
  teamName?: string;
  conversationsAnalyzed: number;
  /** Minutos. */
  firstResponseTimeMinutes: number;
  averageResponseTimeMinutes: number;
  overallScore: number;
  criteria: QualityCriterion[];
  strengths: string[];
  developmentAreas: string[];
  coachingSuggestion: string;
}

/* ==========================================================================
   Funil
   ========================================================================== */

export interface FunnelStepSummary {
  stepId: string;
  stepName: string;
  order: number;
  cardCount: number;
  totalValue: number;
  /** Cards parados ha mais dias que o esperado para a etapa. */
  stalledCount: number;
}

export interface FunnelSummary {
  panelId: string;
  panelName: string;
  panelType: PanelType;
  steps: FunnelStepSummary[];
  misplacedCards: MisplacedCard[];
}

export interface MisplacedCard {
  cardId: string;
  title: string;
  currentStepName: string;
  recommendedStepName: string;
  reason: string;
  confidence: number;
}

/* ==========================================================================
   Recomendacoes
   ========================================================================== */

export interface Recommendation {
  id: string;
  accountId: string;
  title: string;
  description: string;
  impact: "ALTO" | "MEDIO" | "BAIXO";
  effort: "BAIXO" | "MEDIO" | "ALTO";
  category: "FUNIL" | "FOLLOWUP" | "QUALIDADE" | "DADOS" | "RECOMPRA";
  affectedCount: number;
  evidenceSummary: string;
  relatedOpportunityIds: string[];
}

/* ==========================================================================
   Chat
   ========================================================================== */

export interface ChatCitation {
  label: string;
  /** Rota interna do modulo ou deep link resolvido no servidor. */
  href: string;
  kind: "ATENDIMENTO" | "CARD" | "CONTATO" | "OPORTUNIDADE";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations?: ChatCitation[];
  /** Acoes praticas oferecidas junto da resposta. */
  suggestedActions?: { label: string; opportunityId?: string }[];
  /** true quando a IA nao tinha dados suficientes para responder. */
  insufficientData?: boolean;
}

/* ==========================================================================
   Auditoria
   ========================================================================== */

export interface AuditLogEntry {
  id: string;
  accountId: string;
  /** Usuario que solicitou a acao. "SISTEMA" para rotinas automaticas. */
  requestedByUserId: string;
  requestedByName: string;
  occurredAt: string;

  actionType: ActionType;
  actionStatus: ActionStatus;

  targetKind: "ATENDIMENTO" | "CARD" | "CONTATO" | "OPORTUNIDADE";
  targetId: string;
  targetLabel: string;

  /** Resumo do que a IA sugeriu. */
  suggestion: string;
  /** Evidencias que sustentaram a sugestao. */
  evidenceCodes: string[];
  /** Estado antes da acao. */
  before: Record<string, unknown> | null;
  /** Estado depois da acao. */
  after: Record<string, unknown> | null;

  aiConfidence: number;
  automationMode: AutomationMode;

  /** Resultado bruto retornado pela API, quando houve chamada. */
  apiResult: { ok: boolean; statusCode?: number; message?: string } | null;
  success: boolean;

  approvedByUserId?: string;
  approvedByName?: string;
  approvedAt?: string;
}

/* ==========================================================================
   Configuracoes de integracao
   ========================================================================== */

export interface AutomationGuardrails {
  /** Acoes de baixo risco liberadas no modo AUTOMATICO_CONTROLADO. */
  allowedAutoActions: ActionType[];
  /** Acoes que exigem confirmacao humana em qualquer modo. */
  alwaysRequireConfirmation: ActionType[];
}

export interface IntegrationSettings {
  accountId: string;
  automationMode: AutomationMode;
  guardrails: AutomationGuardrails;
  /** Dias de retencao dos dados analisados. */
  dataRetentionDays: number;
  /** Autorizacao explicita para uso das conversas em treinamento de modelo. */
  allowTrainingUsage: boolean;
  /** Painel padrao usado ao criar cards. */
  defaultPanelId?: string;
  /** Etapa de triagem usada no modo automatico. */
  triageStepId?: string;
  updatedAt: string;
  updatedByUserId?: string;
}

/* ==========================================================================
   Webhooks
   ========================================================================== */

export interface WebhookEventRecord {
  id: string;
  accountId: string;
  event: WebhookEvent | string;
  /** Chave de deduplicacao derivada do payload. */
  idempotencyKey: string;
  receivedAt: string;
  processedAt?: string;
  status: "RECEBIDO" | "ENFILEIRADO" | "PROCESSADO" | "IGNORADO" | "FALHOU";
  /** Payload cru com dados sensiveis mascarados. */
  payloadMasked: Record<string, unknown>;
  error?: string;
}

/* ==========================================================================
   Contexto do widget
   ========================================================================== */

export interface WidgetContext {
  accountId: string;
  userId: string;
  contactId?: string;
  sessionId?: string;
  cardId?: string;
  origin: WidgetOrigin;
}

/* ==========================================================================
   Envelope de resposta das rotas de API
   ========================================================================== */

export type ApiEnvelope<T> =
  | { ok: true; data: T; meta: ResponseMeta }
  | { ok: false; error: ApiErrorBody };

export interface ResponseMeta {
  /** mock -> dados simulados. live -> dados reais da API. */
  dataMode: "mock" | "live";
  generatedAt: string;
  /** Avisos de contrato ainda nao validado que afetaram esta resposta. */
  pendingValidation?: string[];
}

export interface ApiErrorBody {
  code:
    | "SEM_PERMISSAO"
    | "NAO_AUTENTICADO"
    | "PARAMETROS_INVALIDOS"
    | "SEM_INTEGRACAO"
    | "ERRO_API"
    | "LIMITE_REQUISICOES"
    | "CONFLITO_DADOS"
    | "AGUARDANDO_APROVACAO"
    | "CONTRATO_NAO_VALIDADO"
    | "ERRO_INTERNO";
  message: string;
  details?: Record<string, unknown>;
}
