/**
 * Enumeracoes de dominio do Flowi Copilot Comercial.
 *
 * Convencao de confiabilidade usada em todo o modulo:
 *  - CONFIRMED          -> verificado na documentacao oficial da KlipFlowi/Helena.
 *  - PENDING_VALIDATION -> ainda nao verificado. Nunca assuma que e verdadeiro.
 */

/** Origem de onde o widget contextual foi aberto. */
export const WIDGET_ORIGINS = ["atendimento", "crm"] as const;
export type WidgetOrigin = (typeof WIDGET_ORIGINS)[number];

/** Modos de automacao configuraveis. O padrao do produto e COPILOTO. */
export const AUTOMATION_MODES = [
  "OBSERVADOR",
  "COPILOTO",
  "AUTOMATICO_CONTROLADO",
] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const DEFAULT_AUTOMATION_MODE: AutomationMode = "COPILOTO";

/** Prioridade comercial derivada do score. */
export const PRIORITIES = ["CRITICA", "ALTA", "MEDIA", "BAIXA"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Status de card do CRM.
 * PENDENTE DE VALIDACAO: os literais aceitos pela API precisam ser confirmados
 * no OpenAPI de painéis/cards antes de qualquer escrita real.
 */
export const CARD_STATUSES = ["OPEN", "WON", "LOST", "ARCHIVED"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/**
 * Tipos de painel.
 * PENDENTE DE VALIDACAO: confirmar os literais no OpenAPI.
 */
export const PANEL_TYPES = ["SALES", "MANAGEMENT"] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

/** Estados do ciclo de vida de uma oportunidade detectada pela IA. */
export const OPPORTUNITY_STATES = [
  "NOVA",
  "ANALISADA",
  "EM_ANDAMENTO",
  "CONVERTIDA",
  "IGNORADA",
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

/** Perfis de usuario. Determinam escopo de leitura e poder de aprovacao. */
export const USER_ROLES = ["VENDEDOR", "GESTOR", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Acoes que a IA pode sugerir ou executar. */
export const ACTION_TYPES = [
  "CRIAR_CARD",
  "ATUALIZAR_CARD",
  "MOVER_ETAPA",
  "APLICAR_ETIQUETAS",
  "REMOVER_ETIQUETAS",
  "ATRIBUIR_RESPONSAVEL",
  "ATUALIZAR_VALOR",
  "CRIAR_NOTA",
  "DEFINIR_FOLLOWUP",
  "MARCAR_ANALISADA",
  "IGNORAR_RECOMENDACAO",
  "ENVIAR_MENSAGEM",
  "MARCAR_GANHA",
  "MARCAR_PERDIDA",
  "ARQUIVAR",
  "EXCLUIR_DADOS",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Situacao de uma acao no fluxo de aprovacao/execucao. */
export const ACTION_STATUSES = [
  "SUGERIDA",
  "AGUARDANDO_APROVACAO",
  "APROVADA",
  "EXECUTADA",
  "FALHOU",
  "REJEITADA",
  "BLOQUEADA_POR_MODO",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/**
 * Eventos de webhook declarados no briefing do produto.
 * PENDENTE DE VALIDACAO: confirmar os nomes exatos e o formato do payload
 * na documentacao de webhooks antes de habilitar o processamento real.
 */
export const WEBHOOK_EVENTS = [
  "SESSION_NEW",
  "SESSION_UPDATE",
  "SESSION_COMPLETE",
  "MESSAGE_RECEIVED",
  "MESSAGE_SENT",
  "CONTACT_NEW",
  "CONTACT_UPDATE",
  "CONTACT_TAG_UPDATE",
  "PANEL_CARD_NEW",
  "PANEL_CARD_UPDATE",
  "PANEL_CARD_STEP_CHANGE",
  "PANEL_CARD_NOTE_NEW",
  "PANEL_CARD_NOTE_UPDATE",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Canais de atendimento. Lista aberta: a API pode devolver outros valores. */
export const CHANNELS = [
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "TELEGRAM",
  "EMAIL",
  "WEBCHAT",
  "SMS",
  "OUTRO",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** Confiabilidade de um contrato de integracao. */
export type ContractTrust = "CONFIRMED" | "PENDING_VALIDATION";
