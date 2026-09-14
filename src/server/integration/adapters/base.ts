import "server-only";
import { getEnv } from "@/server/config/env";
import { MappingReport } from "../mappers/tolerant";

/**
 * Contrato comum dos adapters.
 *
 * Toda leitura devolve um `AdapterResult`, que carrega tanto os dados quanto
 * a procedencia deles. A UI usa `source` para nunca afirmar que algo veio da
 * API quando na verdade veio do dataset simulado.
 */
export interface AdapterResult<T> {
  data: T;
  /** De onde os dados vieram de fato. */
  source: "mock" | "live";
  /** Contratos ou campos que continuam sem confirmacao documental. */
  pendingValidation: string[];
}

export function mockResult<T>(data: T, pending: string[] = []): AdapterResult<T> {
  return { data, source: "mock", pendingValidation: pending };
}

export function liveResult<T>(data: T, report?: MappingReport, entity = "payload"): AdapterResult<T> {
  return {
    data,
    source: "live",
    pendingValidation: report?.toPendingMessages(entity) ?? [],
  };
}

/** true quando o adapter deve usar o dataset simulado. */
export function shouldUseMock(): boolean {
  return getEnv().dataMode !== "live";
}

/**
 * Gera uma chave de idempotencia estavel para uma acao.
 *
 * A mesma acao logica (mesma conta, mesmo alvo, mesmo tipo, mesma intencao)
 * produz sempre a mesma chave. Assim um retry — ou um clique duplo do
 * usuario — nunca cria dois cards.
 */
export function buildIdempotencyKey(parts: {
  accountId: string;
  actionType: string;
  targetId: string;
  /** Discriminador extra, ex.: hash do payload. */
  discriminator?: string;
}): string {
  const raw = [
    parts.accountId,
    parts.actionType,
    parts.targetId,
    parts.discriminator ?? "",
  ].join("|");

  // FNV-1a: suficiente para deduplicacao, sem dependencia externa.
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `flowi-${hash.toString(16).padStart(8, "0")}-${parts.actionType.toLowerCase()}`;
}
