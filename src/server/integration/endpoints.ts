import type { ContractTrust } from "@/domain/enums";

/**
 * ===========================================================================
 * REGISTRY DE ENDPOINTS DA API KLIPFLOWI / FLW.CHAT
 * ===========================================================================
 *
 * FONTE: indice oficial da documentacao (https://flwchat.readme.io/llms.txt),
 * fornecido em 14/09/2026. Cada caminho abaixo foi derivado do slug oficial
 * da pagina de referencia correspondente.
 *
 * COMO LER O CAMPO `trust`:
 *
 *  CONFIRMED
 *    O metodo e o caminho constam do indice oficial da documentacao.
 *
 *  PENDING_VALIDATION
 *    Algo neste contrato ainda NAO foi verificado na pagina detalhada do
 *    endpoint. Normalmente e o `group` (prefixo de servico) ou o formato do
 *    corpo da requisicao. Ver o campo `pending` de cada entrada.
 *
 * SOBRE O PREFIXO DE SERVICO (`group`):
 * A documentacao confirma DOIS prefixos em descricoes de endpoints:
 *   - "POST /core/v2/file"              -> grupo `core`
 *   - "/chat/v1/message/{id}/status"    -> grupo `chat`
 * Para os demais grupos o prefixo foi INFERIDO pela natureza do recurso e
 * esta marcado como pendente. Confirme abrindo a pagina do endpoint
 * (acrescente `.md` a URL) e ajuste aqui ou via variavel de ambiente.
 *
 * OVERRIDE POR AMBIENTE:
 * Qualquer caminho pode ser sobrescrito por `FLW_EP_<CHAVE>`, ex.:
 *   FLW_EP_SESSIONS_LIST=/v2/session
 * ===========================================================================
 */

/** Grupos de servico. Cada um resolve para uma URL base propria. */
export type ApiGroup = "core" | "chat" | "auth";

export interface EndpointContract {
  /** Chave estavel usada pelos adapters e pelos overrides de ambiente. */
  key: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Caminho relativo a URL base do grupo. Placeholders no formato {nome}. */
  path: string;
  group: ApiGroup;
  /** Confiabilidade geral do contrato. */
  trust: ContractTrust;
  /** O que ainda precisa ser confirmado. Vazio quando trust = CONFIRMED. */
  pending: string[];
  /** Descricao oficial resumida. */
  summary: string;
}

/** Motivo padrao de pendencia quando so falta confirmar o prefixo de servico. */
const PREFIXO_PENDENTE =
  "Prefixo de servico (core/chat) inferido: confirmar na pagina do endpoint.";

/** Prefixo confirmado em descricao oficial da documentacao. */
const NADA_PENDENTE: string[] = [];

function ep(
  key: string,
  method: EndpointContract["method"],
  path: string,
  group: ApiGroup,
  summary: string,
  pending: string[] = [PREFIXO_PENDENTE],
): EndpointContract {
  return {
    key,
    method,
    path,
    group,
    trust: pending.length === 0 ? "CONFIRMED" : "PENDING_VALIDATION",
    pending,
    summary,
  };
}

/* ==========================================================================
   CONVERSAS (grupo `chat` — prefixo confirmado via "/chat/v1/message/...")
   ========================================================================== */
const SESSIONS = {
  LIST: ep("SESSIONS_LIST", "GET", "/v2/session", "chat", "Listagem paginada de conversas.", NADA_PENDENTE),
  GET_BY_ID: ep("SESSIONS_GET_BY_ID", "GET", "/v2/session/{id}", "chat", "Obter conversa por ID.", NADA_PENDENTE),
  TRANSFER: ep("SESSIONS_TRANSFER", "PUT", "/v1/session/{id}/transfer", "chat", "Transferir conversa.", NADA_PENDENTE),
  SET_ASSIGNEE: ep("SESSIONS_SET_ASSIGNEE", "PUT", "/v1/session/{id}/assignee", "chat", "Atribuir usuario a conversa.", NADA_PENDENTE),
  COMPLETE: ep("SESSIONS_COMPLETE", "PUT", "/v1/session/{id}/complete", "chat", "Concluir conversa.", NADA_PENDENTE),
  SET_STATUS: ep("SESSIONS_SET_STATUS", "PUT", "/v1/session/{id}/status", "chat", "Alterar status da conversa.", NADA_PENDENTE),
  PATCH: ep("SESSIONS_PATCH", "PUT", "/v2/session/{id}/partial", "chat", "Atualizar atributos especificos da conversa.", [
    "Corpo exige lista de atributos a atualizar: confirmar formato exato.",
  ]),
} as const;

/* ==========================================================================
   MENSAGENS E NOTAS INTERNAS DE ATENDIMENTO (grupo `chat` — confirmado)
   ========================================================================== */
const MESSAGES = {
  LIST_BY_SESSION: ep("MESSAGES_LIST_BY_SESSION", "GET", "/v1/session/{id}/message", "chat", "Listagem paginada de mensagens de uma conversa.", NADA_PENDENTE),
  LIST: ep("MESSAGES_LIST", "GET", "/v1/message", "chat", "Listagem paginada de mensagens.", NADA_PENDENTE),
  GET_BY_ID: ep("MESSAGES_GET_BY_ID", "GET", "/v1/message/{id}", "chat", "Obter mensagem por ID.", NADA_PENDENTE),
  GET_STATUS: ep("MESSAGES_GET_STATUS", "GET", "/v1/message/{id}/status", "chat", "Obter status de envio da mensagem.", NADA_PENDENTE),

  /**
   * ATENCAO: endpoints de ESCRITA que enviam mensagem ao cliente final.
   * Declarados para completude do adapter, porem o modulo NUNCA os invoca
   * na primeira entrega. Exigem confirmacao humana explicita em todos os
   * modos de automacao (ver automation.service.ts).
   */
  SEND_IN_SESSION: ep("MESSAGES_SEND_IN_SESSION", "POST", "/v1/session/{id}/message", "chat", "Enviar mensagem na conversa (assincrono).", NADA_PENDENTE),
  SEND_IN_SESSION_SYNC: ep("MESSAGES_SEND_IN_SESSION_SYNC", "POST", "/v1/session/{id}/message/sync", "chat", "Enviar mensagem na conversa (sincrono, ate 25s).", NADA_PENDENTE),
  SEND_TEXT: ep("MESSAGES_SEND_TEXT", "POST", "/v1/send/text", "chat", "Enviar mensagem de texto simples a um contato.", NADA_PENDENTE),
} as const;

const SESSION_NOTES = {
  LIST: ep("SESSION_NOTES_LIST", "GET", "/v1/session/{id}/note", "chat", "Listar notas internas do atendimento.", NADA_PENDENTE),
  CREATE: ep("SESSION_NOTES_CREATE", "POST", "/v1/session/{id}/note", "chat", "Salvar nota interna no atendimento.", NADA_PENDENTE),
  GET_BY_ID: ep("SESSION_NOTES_GET_BY_ID", "GET", "/v1/session/note/{id}", "chat", "Obter nota interna por ID.", NADA_PENDENTE),
  DELETE: ep("SESSION_NOTES_DELETE", "DELETE", "/v1/session/note/{id}", "chat", "Excluir nota interna.", NADA_PENDENTE),
} as const;

/* ==========================================================================
   CONTATOS (grupo inferido: core)
   ========================================================================== */
const CONTACTS = {
  LIST: ep("CONTACTS_LIST", "GET", "/v1/contact", "core", "Listagem paginada de contatos."),
  FILTER: ep("CONTACTS_FILTER", "POST", "/v1/contact/filter", "core", "Filtragem paginada de contatos.", [
    PREFIXO_PENDENTE,
    "Campos aceitos no corpo do filtro: confirmar na pagina do endpoint.",
  ]),
  GET_BY_ID: ep("CONTACTS_GET_BY_ID", "GET", "/v1/contact/{id}", "core", "Obter contato por ID."),
  GET_BY_PHONE: ep("CONTACTS_GET_BY_PHONE", "GET", "/v1/contact/phonenumber/{phone}", "core", "Obter contato por numero de telefone."),
  CREATE: ep("CONTACTS_CREATE", "POST", "/v1/contact", "core", "Criar contato."),
  UPDATE: ep("CONTACTS_UPDATE", "PUT", "/v2/contact/{id}", "core", "Atualizar contato."),
  UPDATE_BY_PHONE: ep("CONTACTS_UPDATE_BY_PHONE", "PUT", "/v1/contact/phonenumber/{phone}", "core", "Atualizar contato por telefone."),
  SET_TAGS: ep("CONTACTS_SET_TAGS", "POST", "/v1/contact/{id}/tags", "core", "Atualizar etiquetas do contato.", [
    PREFIXO_PENDENTE,
    "Semantica do corpo: confirmar se substitui a lista inteira ou adiciona.",
  ]),
  SET_TAGS_BY_PHONE: ep("CONTACTS_SET_TAGS_BY_PHONE", "POST", "/v1/contact/phonenumber/{phone}/tags", "core", "Atualizar etiquetas por telefone.", [
    PREFIXO_PENDENTE,
    "Semantica do corpo: confirmar se substitui a lista inteira ou adiciona.",
  ]),
  CUSTOM_FIELDS: ep("CONTACTS_CUSTOM_FIELDS", "GET", "/v1/contact/custom-field", "core", "Campos personalizados de contato."),
} as const;

/* ==========================================================================
   ETIQUETAS (grupo inferido: core)
   ========================================================================== */
const TAGS = {
  LIST: ep("TAGS_LIST", "GET", "/v1/tag", "core", "Listagem de etiquetas da conta."),
  CREATE: ep("TAGS_CREATE", "POST", "/v1/tag", "core", "Criar etiqueta. Sem cor informada, e criada em GRAY_600."),
  LIST_COLORS: ep("TAGS_LIST_COLORS", "GET", "/v1/tag/color", "core", "Cores disponiveis. O valor de `color` vem desta lista."),
  UPDATE: ep("TAGS_UPDATE", "PUT", "/v1/tag/{id}", "core", "Atualizar nome e cor. Cor omitida mantem a atual."),
  DELETE: ep("TAGS_DELETE", "DELETE", "/v1/tag/{id}", "core", "Excluir etiqueta. Se vinculada a contatos, exige `removeFromContacts`."),
} as const;

/* ==========================================================================
   PAINEIS E CARDS DO CRM (grupo inferido: core)
   ========================================================================== */
const PANELS = {
  LIST: ep("PANELS_LIST", "GET", "/v2/panel", "core", "Listar paineis."),
  GET_BY_ID: ep("PANELS_GET_BY_ID", "GET", "/v1/panel/{id}", "core", "Obter painel por ID (inclui etapas)."),
  CUSTOM_FIELDS: ep("PANELS_CUSTOM_FIELDS", "GET", "/v1/panel/{id}/custom-fields", "core", "Campos personalizados do painel."),
  LOST_REASONS: ep("PANELS_LOST_REASONS", "GET", "/v1/panel/{id}/lost-reason", "core", "Listagem paginada de motivos de perda do painel."),
} as const;

const CARDS = {
  LIST: ep("CARDS_LIST", "GET", "/v2/panel/card", "core", "Listagem paginada de cards."),
  CREATE: ep("CARDS_CREATE", "POST", "/v2/panel/card", "core", "Criar card."),
  GET_BY_ID: ep("CARDS_GET_BY_ID", "GET", "/v2/panel/card/{id}", "core", "Obter card por ID."),
  UPDATE: ep("CARDS_UPDATE", "PUT", "/v3/panel/card/{id}", "core", "Atualizar card (etapa, responsavel, valor, status).", [
    PREFIXO_PENDENTE,
    "Nomes exatos dos campos do corpo na v3: confirmar antes de qualquer escrita.",
    "Confirmar como o status WON/LOST e enviado e onde entra o motivo de perda.",
  ]),
  DUPLICATE: ep("CARDS_DUPLICATE", "POST", "/v2/panel/card/{id}/duplicate", "core", "Duplicar card."),
} as const;

const CARD_NOTES = {
  LIST: ep("CARD_NOTES_LIST", "GET", "/v1/panel/card/{cardId}/note", "core", "Listagem paginada de anotacoes do card."),
  CREATE: ep("CARD_NOTES_CREATE", "POST", "/v1/panel/card/{cardId}/note", "core", "Adicionar anotacao ao card."),
  DELETE: ep("CARD_NOTES_DELETE", "DELETE", "/v1/panel/card/{cardId}/note/{noteId}", "core", "Remover anotacao do card."),
} as const;

/* ==========================================================================
   USUARIOS (AGENTES) E EQUIPES (DEPARTAMENTOS) — grupo inferido: core
   ========================================================================== */
const AGENTS = {
  LIST: ep("AGENTS_LIST", "GET", "/v1/agent", "core", "Listar usuarios/atendentes."),
  GET_BY_ID: ep("AGENTS_GET_BY_ID", "GET", "/v1/agent/{id}", "core", "Obter usuario por ID."),
  SET_DEPARTMENTS: ep("AGENTS_SET_DEPARTMENTS", "POST", "/v1/agent/{id}/departments", "core", "Atualizar equipes do usuario."),
} as const;

const DEPARTMENTS = {
  LIST: ep("DEPARTMENTS_LIST", "GET", "/v2/department", "core", "Listar equipes/departamentos."),
  GET_BY_ID: ep("DEPARTMENTS_GET_BY_ID", "GET", "/v1/department/{id}", "core", "Obter equipe por ID."),
  LIST_CHANNELS: ep("DEPARTMENTS_LIST_CHANNELS", "GET", "/v1/department/{id}/channel", "core", "Listar canais da equipe."),
} as const;

/* ==========================================================================
   CANAIS — grupo inferido: core
   ========================================================================== */
const CHANNELS = {
  LIST: ep("CHANNELS_LIST", "GET", "/v1/channel", "core", "Listagem de canais de atendimento."),
} as const;

/* ==========================================================================
   WEBHOOKS — grupo inferido: core
   ========================================================================== */
const WEBHOOKS = {
  LIST_EVENTS: ep("WEBHOOKS_LIST_EVENTS", "GET", "/v1/webhook/event", "core", "Eventos de webhook que podem ser assinados."),
  LIST_SUBSCRIPTIONS: ep("WEBHOOKS_LIST_SUBSCRIPTIONS", "GET", "/v1/webhook/subscription", "core", "Assinaturas ativas e inativas."),
  CREATE_SUBSCRIPTION: ep("WEBHOOKS_CREATE_SUBSCRIPTION", "POST", "/v1/webhook/subscription", "core", "Criar assinatura de webhook.", [
    PREFIXO_PENDENTE,
    "Campos do corpo (url, eventos, segredo) e formato da assinatura HMAC recebida.",
  ]),
  GET_SUBSCRIPTION: ep("WEBHOOKS_GET_SUBSCRIPTION", "GET", "/v1/webhook/subscription/{subscriptionId}", "core", "Obter assinatura por ID."),
  UPDATE_SUBSCRIPTION: ep("WEBHOOKS_UPDATE_SUBSCRIPTION", "PUT", "/v1/webhook/subscription/{subscriptionId}", "core", "Atualizar assinatura."),
  DELETE_SUBSCRIPTION: ep("WEBHOOKS_DELETE_SUBSCRIPTION", "DELETE", "/v1/webhook/subscription/{subscriptionId}", "core", "Remover assinatura."),
} as const;

/* ==========================================================================
   LOGIN INTEGRADO — grupo `auth`
   --------------------------------------------------------------------------
   A documentacao confirma que o recurso EXISTE ("Login integrado: e possivel
   integrar o login entre plataformas, gerando um token via API e direcionando
   o usuario"), mas o metodo e o caminho NAO aparecem no indice.
   Enquanto isso nao for confirmado, `deep-link` devolve apenas a URL relativa
   do atendimento, SEM token. Ver auth.adapter.ts.
   ========================================================================== */
const AUTH = {
  INTEGRATED_LOGIN: {
    key: "AUTH_INTEGRATED_LOGIN",
    method: "POST" as const,
    path: "",
    group: "auth" as const,
    trust: "PENDING_VALIDATION" as ContractTrust,
    pending: [
      "Metodo e caminho do endpoint de login integrado NAO constam do indice.",
      "Formato do corpo (userId, redirect) e do token de retorno.",
      "Tempo de expiracao do token gerado.",
      "Fonte a confirmar: https://flwchat.readme.io/reference/login-integrado.md",
    ],
    summary: "Gerar token de login integrado para redirecionar o usuario.",
  } satisfies EndpointContract,
} as const;

/* ==========================================================================
   Registry publico
   ========================================================================== */
export const ENDPOINTS = {
  SESSIONS,
  MESSAGES,
  SESSION_NOTES,
  CONTACTS,
  TAGS,
  PANELS,
  CARDS,
  CARD_NOTES,
  AGENTS,
  DEPARTMENTS,
  CHANNELS,
  WEBHOOKS,
  AUTH,
} as const;

/** Achata o registry em uma lista para inspecao e para a tela de diagnostico. */
export function listAllEndpoints(): EndpointContract[] {
  const out: EndpointContract[] = [];
  for (const group of Object.values(ENDPOINTS)) {
    for (const contract of Object.values(group)) {
      out.push(contract as EndpointContract);
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Endpoints que ainda dependem de confirmacao documental. */
export function listPendingEndpoints(): EndpointContract[] {
  return listAllEndpoints().filter((c) => c.trust === "PENDING_VALIDATION");
}

/**
 * Resolve o caminho final de um endpoint, aplicando override de ambiente
 * e substituindo os placeholders `{nome}`.
 *
 * Lanca se algum placeholder ficar sem valor: melhor falhar do que montar
 * uma URL silenciosamente errada.
 */
export function resolvePath(
  contract: EndpointContract,
  params: Record<string, string | number> = {},
): string {
  const override = process.env[`FLW_EP_${contract.key}`];
  const template = override && override.trim().length > 0 ? override.trim() : contract.path;

  if (template.length === 0) {
    throw new Error(
      `[endpoints] O endpoint ${contract.key} nao possui caminho definido. ` +
        `Pendencias: ${contract.pending.join(" | ")}. ` +
        `Defina FLW_EP_${contract.key} apos confirmar na documentacao.`,
    );
  }

  return template.replace(/\{(\w+)\}/g, (_full, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `[endpoints] Parametro "${name}" ausente ao montar ${contract.key} (${template}).`,
      );
    }
    return encodeURIComponent(String(value));
  });
}
