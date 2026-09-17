import "server-only";
import type { MessageSnapshot } from "@/domain/types";
import { findConversation } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequestAllPages } from "../http/client";
import {
  MappingReport,
  readArray,
  readDate,
  readRecord,
  readString,
} from "../mappers/tolerant";
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

/**
 * Quem enviou a mensagem.
 *
 * CONFIRMADO no payload real: a API NAO usa INBOUND/OUTBOUND. O valor
 * observado e `FROM_HUB`, e nenhuma das palavras que este mapeador procurava
 * ("OUT", "SENT", "ENVIAD") aparece nele — entao TODA mensagem caia no
 * padrao e a conversa inteira era atribuida a um so lado.
 *
 * O estrago era grande e silencioso: sem saber quem falou, a analise nao
 * distingue "preco pedido pelo cliente" de "preco enviado pelo atendente",
 * que sao sinais comerciais opostos. Os relatorios de qualidade tambem
 * dependem disso para medir tempo de resposta.
 *
 * O criterio primario e `userId`: mensagem de atendente carrega o id de quem
 * escreveu; mensagem que chega do cliente vem com ele nulo. E um fato do
 * dado, nao uma inferencia sobre o nome do enum.
 *
 * Os literais entram como reforco, na leitura mais provavel — "HUB" aqui e o
 * gateway do canal, entao FROM_HUB e o que CHEGOU ao sistema. Se a leitura
 * estiver invertida, a correcao e uma linha; enquanto isso, `userId` decide.
 */
function normalizeDirection(
  raw?: string,
  temUsuario?: boolean,
): MessageSnapshot["direction"] {
  if (temUsuario === true) return "OUTBOUND";

  const upper = (raw ?? "").toUpperCase();

  if (upper === "TO_HUB" || upper.includes("OUT") || upper.includes("SENT") || upper.includes("ENVIAD")) {
    return "OUTBOUND";
  }
  if (upper === "FROM_HUB" || upper.includes("IN") || upper.includes("RECEB")) {
    return "INBOUND";
  }

  // Sem usuario e sem literal reconhecido: veio do cliente.
  return "INBOUND";
}

/**
 * Texto da mensagem, incluindo a TRANSCRICAO de audio.
 *
 * CONFIRMADO: a KlipFlowi transcreve audios e guarda o resultado em
 * `details.transcription.text`. O campo `text` vem nulo nessas mensagens.
 *
 * Ler so `text` deixava a analise cega justamente onde a negociacao
 * acontece: na conversa que motivou esta correcao, 12 das 20 mensagens sao
 * audio — incluindo o cliente dizendo que a compra fica "para o comeco do
 * mes, dia 5, dia 10" e que quer "uma maquina que nao seja muito cara".
 * Prazo e objecao de orcamento, ambos invisiveis.
 */
function readTexto(raw: unknown, report: MappingReport): { texto: string; transcrito: boolean } {
  const direto = readString(
    raw,
    ["text", "body", "content", "message", "caption"],
    "message.text",
    report,
  );
  if (direto) return { texto: direto, transcrito: false };

  const details = readRecord(raw, ["details"], "message.details");
  if (!details) return { texto: "", transcrito: false };

  const transcription = readRecord(details, ["transcription"], "message.transcription");
  if (!transcription) return { texto: "", transcrito: false };

  // Transcricao ainda em processamento ou com erro nao e texto confiavel.
  const comErro = transcription["error"] === true;
  const processando = transcription["processing"] === true;
  if (comErro || processando) return { texto: "", transcrito: false };

  const texto = readString(transcription, ["text"], "message.transcription.text");
  return texto ? { texto, transcrito: true } : { texto: "", transcrito: false };
}

export function mapMessage(
  raw: unknown,
  sessionId: string,
  report: MappingReport,
): MessageSnapshot | null {
  const id = readString(raw, ["id", "messageId", "uuid"], "message.id", report);
  if (!id) return null;

  const { texto: text, transcrito } = readTexto(raw, report);
  const userId = readString(raw, ["userId"], "message.userId", report);

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
      readString(raw, ["direction"], "message.direction", report),
      Boolean(userId),
    ),
    transcrito,
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
