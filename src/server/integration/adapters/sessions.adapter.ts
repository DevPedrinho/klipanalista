import "server-only";
import type { Channel } from "@/domain/enums";
import type { ConversationSnapshot } from "@/domain/types";
import { MOCK_CONVERSATIONS, findConversation } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import {
  MappingReport,
  readDate,
  readNumber,
  readRecord,
  readString,
} from "../mappers/tolerant";
import { liveResult, mockResult, shouldUseMock, type AdapterResult } from "./base";
import { messagesAdapter } from "./messages.adapter";

/**
 * SessionsAdapter — conversas/atendimentos.
 *
 * Endpoints CONFIRMADOS no indice oficial:
 *   GET  /v2/session            Listagem paginada de conversas
 *   GET  /v2/session/{id}       Obter por ID
 *   PUT  /v1/session/{id}/...   transfer | assignee | complete | status
 *
 * NOMES DOS CAMPOS — CONFIRMADOS pela sonda contra a conta real:
 *   contactId, channelType, userId (o atendente), status, startAt,
 *   lastInteractionDate, lastMessageIn, lastMessageOut, firstResponseAt,
 *   timeWait, timeService, previewUrl, agentDetails.
 *
 * As variantes alternativas continuam na lista de tentativas, para
 * instancias com versao diferente, mas o nome oficial vem sempre primeiro.
 */

function normalizeChannel(raw?: string): Channel {
  if (!raw) return "OUTRO";
  const upper = raw.toUpperCase();
  const known: Channel[] = [
    "WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM", "EMAIL", "WEBCHAT", "SMS",
  ];
  return known.find((c) => upper.includes(c)) ?? "OUTRO";
}

function normalizeStatus(raw?: string): ConversationSnapshot["status"] {
  const upper = (raw ?? "").toUpperCase();
  if (upper.includes("CLOS") || upper.includes("COMPLET") || upper.includes("CONCLU")) return "CLOSED";
  if (upper.includes("PEND") || upper.includes("WAIT") || upper.includes("AGUARD")) return "PENDING";
  return "OPEN";
}

export function mapSession(
  raw: unknown,
  accountId: string,
  report: MappingReport,
): ConversationSnapshot | null {
  const id = readString(raw, ["id", "sessionId", "uuid"], "session.id", report);
  const contactId = readString(raw, ["contactId", "contact_id", "contact"], "session.contactId", report);

  // Sem id nao ha o que mapear: descartamos em vez de fabricar um.
  if (!id) return null;

  // CONFIRMADO: `startAt` e o inicio do atendimento; `createdAt` e a criacao
  // do registro. Para "ha quanto tempo esta conversa existe", vale o primeiro.
  const startedAt = readDate(
    raw,
    ["startAt", "createdAt", "startedAt", "openedAt"],
    "session.startedAt",
    report,
  );

  /**
   * Recencia da conversa.
   *
   * CONFIRMADO no payload real: o campo e `lastInteractionDate`. Antes o
   * mapeador tentava `lastMessageAt` e `lastInteractionAt` — nenhum dos dois
   * existe — e caia em `updatedAt`, que muda a cada alteracao de qualquer
   * atributo da conversa. O efeito era grave e silencioso: uma conversa
   * parada ha dias parecia recente, o que inflava a pontuacao de recencia e
   * escondia justamente a oportunidade esquecida que este modulo existe para
   * encontrar.
   */
  const lastMessageAt = readDate(
    raw,
    ["lastInteractionDate", "lastMessageAt", "updatedAt"],
    "session.lastMessageAt",
    report,
  );

  const agentDetails = readRecord(raw, ["agentDetails"], "session.agentDetails", report);

  return {
    id,
    accountId,
    contactId: contactId ?? "",
    channel: normalizeChannel(readString(raw, ["channelType", "channel", "type"], "session.channel", report)),
    agentId: readString(raw, ["userId", "agentId", "assigneeId", "responsibleId"], "session.agentId", report),
    // CONFIRMADO: o nome do atendente vem dentro de `agentDetails`.
    agentName: agentDetails
      ? readString(agentDetails, ["name", "shortName"], "session.agentDetails.name")
      : readString(raw, ["userName", "agentName"], "session.agentName", report),
    status: normalizeStatus(readString(raw, ["status", "state", "situation"], "session.status", report)),
    startedAt: startedAt ?? new Date(0).toISOString(),
    lastMessageAt: lastMessageAt ?? startedAt ?? new Date(0).toISOString(),

    lastInboundAt: readDate(raw, ["lastMessageIn"], "session.lastMessageIn", report),
    lastOutboundAt: readDate(raw, ["lastMessageOut"], "session.lastMessageOut", report),
    firstResponseAt: readDate(raw, ["firstResponseAt"], "session.firstResponseAt", report),
    waitSeconds: readNumber(raw, ["timeWait"], "session.timeWait", report),
    serviceSeconds: readNumber(raw, ["timeService"], "session.timeService", report),
    previewUrl: readString(raw, ["previewUrl"], "session.previewUrl", report),

    // Mensagens vem de um endpoint proprio; aqui a lista comeca vazia.
    messages: [],
  };
}

export interface ListSessionsParams {
  accountId: string;
  /** ISO 8601. */
  updatedAfter?: string;
  agentIds?: string[];
  maxPages?: number;
}

export const sessionsAdapter = {
  /** Lista conversas do periodo, sem carregar as mensagens. */
  async list(params: ListSessionsParams): Promise<AdapterResult<ConversationSnapshot[]>> {
    if (shouldUseMock()) {
      let data = MOCK_CONVERSATIONS.filter((c) => c.accountId === params.accountId);

      if (params.updatedAfter) {
        const cutoff = Date.parse(params.updatedAfter);
        data = data.filter((c) => Date.parse(c.lastMessageAt) >= cutoff);
      }
      if (params.agentIds && params.agentIds.length > 0) {
        const allowed = new Set(params.agentIds);
        data = data.filter((c) => !c.agentId || allowed.has(c.agentId));
      }
      return mockResult(data);
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(
      ENDPOINTS.SESSIONS.LIST,
      { query: { updatedAfter: params.updatedAfter } },
      {},
      params.maxPages ?? 10,
    );

    const sessions = raw
      .map((item) => mapSession(item, params.accountId, report))
      .filter((s): s is ConversationSnapshot => s !== null);

    return liveResult(sessions, report, "Conversa");
  },

  /** Obtem uma conversa com todas as mensagens carregadas. */
  async getWithMessages(params: {
    accountId: string;
    sessionId: string;
  }): Promise<AdapterResult<ConversationSnapshot | null>> {
    if (shouldUseMock()) {
      const found = findConversation(params.sessionId);
      const scoped = found && found.accountId === params.accountId ? found : null;
      return mockResult(scoped);
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(ENDPOINTS.SESSIONS.GET_BY_ID, {
      pathParams: { id: params.sessionId },
    });

    const session = mapSession(response.data, params.accountId, report);
    if (!session) return liveResult(null, report, "Conversa");

    const messages = await messagesAdapter.listBySession({
      accountId: params.accountId,
      sessionId: params.sessionId,
    });

    return liveResult(
      { ...session, messages: messages.data },
      report,
      "Conversa",
    );
  },
};
