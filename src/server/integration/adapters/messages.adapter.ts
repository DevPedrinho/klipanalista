import "server-only";
import type { MessageSnapshot } from "@/domain/types";
import { findConversation } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequestAllPages } from "../http/client";
import { MappingReport, readArray, readDate, readString } from "../mappers/tolerant";
import { liveResult, mockResult, shouldUseMock, type AdapterResult } from "./base";

/**
 * MessagesAdapter — mensagens de um atendimento.
 *
 * Endpoints CONFIRMADOS:
 *   GET /v1/session/{id}/message   Listagem paginada de mensagens da conversa
 *   GET /v1/message/{id}           Obter por ID
 *   GET /v1/message/{id}/status    Status de envio
 *
 * ESCRITA: os endpoints de envio existem e estao declarados no registry,
 * porem este adapter NAO expoe metodo de envio. Enviar mensagem ao cliente
 * exige confirmacao humana e esta fora do escopo da primeira entrega.
 */

function normalizeDirection(raw?: string, fromMe?: boolean): MessageSnapshot["direction"] {
  if (typeof fromMe === "boolean") return fromMe ? "OUTBOUND" : "INBOUND";

  const upper = (raw ?? "").toUpperCase();
  if (upper.includes("OUT") || upper.includes("SENT") || upper.includes("ENVIAD")) return "OUTBOUND";
  return "INBOUND";
}

export function mapMessage(
  raw: unknown,
  sessionId: string,
  report: MappingReport,
): MessageSnapshot | null {
  const id = readString(raw, ["id", "messageId", "uuid"], "message.id", report);
  if (!id) return null;

  const text =
    readString(raw, ["text", "body", "content", "message", "caption"], "message.text", report) ?? "";

  const sentAt = readDate(
    raw,
    ["createdAt", "sentAt", "timestamp", "created_at", "date"],
    "message.sentAt",
    report,
  );

  const attachmentsRaw = readArray(raw, ["attachments", "files", "media"], "message.attachments", report);

  return {
    id,
    sessionId,
    direction: normalizeDirection(
      readString(raw, ["direction", "type", "origin"], "message.direction", report),
      undefined,
    ),
    authorName: readString(raw, ["userName", "authorName", "senderName", "from"], "message.authorName", report),
    text,
    sentAt: sentAt ?? new Date(0).toISOString(),
    attachments: attachmentsRaw.map((item) => ({
      // Apenas metadados: o conteudo do anexo nunca e baixado nem analisado.
      type: readString(item, ["type", "mimeType", "contentType"], "attachment.type") ?? "desconhecido",
      name: readString(item, ["name", "fileName", "filename"], "attachment.name"),
    })),
  };
}

export const messagesAdapter = {
  async listBySession(params: {
    accountId: string;
    sessionId: string;
    maxPages?: number;
  }): Promise<AdapterResult<MessageSnapshot[]>> {
    if (shouldUseMock()) {
      const conversation = findConversation(params.sessionId);
      const scoped =
        conversation && conversation.accountId === params.accountId ? conversation.messages : [];
      return mockResult(scoped);
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(
      ENDPOINTS.MESSAGES.LIST_BY_SESSION,
      { pathParams: { id: params.sessionId } },
      {},
      params.maxPages ?? 8,
    );

    const messages = raw
      .map((item) => mapMessage(item, params.sessionId, report))
      .filter((m): m is MessageSnapshot => m !== null)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));

    return liveResult(messages, report, "Mensagem");
  },
};
