import "server-only";
import type { WebhookEventRecord } from "@/domain/types";

/**
 * Fila de analise e registro de eventos de webhook.
 *
 * Regras do produto implementadas aqui:
 *  - salvar o evento recebido;
 *  - enfileirar o atendimento para analise;
 *  - NAO reanalisar a mesma conversa em intervalos muito curtos (debounce);
 *  - so reprocessar quando houver informacao nova relevante;
 *  - idempotencia: o mesmo evento entregue duas vezes conta como um.
 *
 * Armazenamento em memoria nesta entrega. A interface corresponde as tabelas
 * `webhook_events` e a fila de analise descritas em db/migrations/0001_init.sql.
 */

/** Intervalo minimo entre duas analises da MESMA conversa. */
export const ANALYSIS_DEBOUNCE_MS = 5 * 60_000;

const events: WebhookEventRecord[] = [];
const seenIdempotencyKeys = new Set<string>();

const MAX_EVENTS = 5000;

export interface QueueItem {
  accountId: string;
  sessionId: string;
  /** Momento em que a analise deve ocorrer, no minimo. */
  notBefore: number;
  enqueuedAt: number;
  reason: string;
}

const queue = new Map<string, QueueItem>();
/** Ultima analise concluida por conversa. */
const lastAnalyzedAt = new Map<string, number>();

function queueKey(accountId: string, sessionId: string): string {
  return `${accountId}::${sessionId}`;
}

/**
 * Registra um evento recebido. Devolve `duplicate: true` quando a mesma
 * entrega ja havia sido processada.
 */
export function recordWebhookEvent(params: {
  accountId: string;
  event: string;
  idempotencyKey: string;
  payloadMasked: Record<string, unknown>;
}): { record: WebhookEventRecord; duplicate: boolean } {
  if (seenIdempotencyKeys.has(params.idempotencyKey)) {
    const existing = events.find((e) => e.idempotencyKey === params.idempotencyKey);
    if (existing) return { record: existing, duplicate: true };
  }

  const record: WebhookEventRecord = {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    accountId: params.accountId,
    event: params.event,
    idempotencyKey: params.idempotencyKey,
    receivedAt: new Date().toISOString(),
    status: "RECEBIDO",
    payloadMasked: params.payloadMasked,
  };

  events.unshift(record);
  seenIdempotencyKeys.add(params.idempotencyKey);

  if (events.length > MAX_EVENTS) {
    const removed = events.splice(MAX_EVENTS);
    for (const item of removed) seenIdempotencyKeys.delete(item.idempotencyKey);
  }

  return { record, duplicate: false };
}

export function markEventStatus(
  eventId: string,
  status: WebhookEventRecord["status"],
  error?: string,
): void {
  const record = events.find((e) => e.id === eventId);
  if (!record) return;

  record.status = status;
  record.processedAt = new Date().toISOString();
  if (error) record.error = error;
}

/**
 * Enfileira uma conversa para analise, respeitando o debounce.
 *
 * Devolve `scheduled: false` quando a conversa foi analisada ha pouco e o
 * evento nao traz informacao nova suficiente para justificar reprocessar.
 */
export function enqueueAnalysis(params: {
  accountId: string;
  sessionId: string;
  reason: string;
  /** Eventos relevantes furam o debounce (ex.: nova mensagem do cliente). */
  relevantChange: boolean;
}): { scheduled: boolean; reason: string } {
  const key = queueKey(params.accountId, params.sessionId);
  const now = Date.now();
  const last = lastAnalyzedAt.get(key);

  if (!params.relevantChange) {
    return {
      scheduled: false,
      reason: "Evento sem informacao nova relevante: score mantido.",
    };
  }

  if (last !== undefined && now - last < ANALYSIS_DEBOUNCE_MS) {
    const existing = queue.get(key);
    if (existing) {
      return { scheduled: false, reason: "Conversa ja esta na fila de analise." };
    }

    // Reagenda para o fim da janela em vez de descartar o evento.
    queue.set(key, {
      accountId: params.accountId,
      sessionId: params.sessionId,
      notBefore: last + ANALYSIS_DEBOUNCE_MS,
      enqueuedAt: now,
      reason: params.reason,
    });
    return {
      scheduled: true,
      reason: `Analise adiada para respeitar o intervalo minimo de ${ANALYSIS_DEBOUNCE_MS / 60000} min.`,
    };
  }

  queue.set(key, {
    accountId: params.accountId,
    sessionId: params.sessionId,
    notBefore: now,
    enqueuedAt: now,
    reason: params.reason,
  });
  return { scheduled: true, reason: "Conversa enfileirada para analise." };
}

/** Itens prontos para processar agora. */
export function dueItems(limit = 20): QueueItem[] {
  const now = Date.now();
  return [...queue.values()]
    .filter((item) => item.notBefore <= now)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    .slice(0, limit);
}

export function markAnalyzed(accountId: string, sessionId: string): void {
  const key = queueKey(accountId, sessionId);
  queue.delete(key);
  lastAnalyzedAt.set(key, Date.now());
}

export function listEvents(params: {
  accountId: string;
  limit?: number;
}): WebhookEventRecord[] {
  return events
    .filter((e) => e.accountId === params.accountId)
    .slice(0, params.limit ?? 50);
}

export function queueStats(accountId: string) {
  const items = [...queue.values()].filter((i) => i.accountId === accountId);
  return {
    pending: items.length,
    due: items.filter((i) => i.notBefore <= Date.now()).length,
    eventsReceived: events.filter((e) => e.accountId === accountId).length,
  };
}

/** Apenas para testes. */
export function clearQueue(): void {
  queue.clear();
  lastAnalyzedAt.clear();
  events.length = 0;
  seenIdempotencyKeys.clear();
}

/**
 * Classifica se um evento traz informacao nova que justifique reanalisar.
 * Eventos puramente administrativos nao mexem no score.
 */
export function isRelevantForAnalysis(event: string): boolean {
  const relevant = new Set([
    "MESSAGE_RECEIVED",
    "MESSAGE_SENT",
    "SESSION_NEW",
    "SESSION_COMPLETE",
    "CONTACT_TAG_UPDATE",
    "PANEL_CARD_STEP_CHANGE",
    "PANEL_CARD_NEW",
    "PANEL_CARD_UPDATE",
  ]);
  return relevant.has(event.toUpperCase());
}
