import { type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getEnv } from "@/server/config/env";
import { verifySignature } from "@/server/integration/adapters";
import { maskDeep } from "@/server/security/masking";
import {
  enqueueAnalysis,
  isRelevantForAnalysis,
  markEventStatus,
  recordWebhookEvent,
} from "@/server/services/queue.service";

/**
 * POST /api/webhooks/klipflowi
 *
 * Receptor de eventos da KlipFlowi.
 *
 * SEGURANCA — FALHA FECHADO:
 *  - sem FLW_WEBHOOK_SECRET configurado, NENHUM evento e aceito;
 *  - assinatura invalida devolve 401 e nada e gravado;
 *  - o payload e mascarado antes de ser armazenado ou logado.
 *
 * PENDENTE DE VALIDACAO: o nome do header de assinatura, o algoritmo e o
 * formato do payload precisam ser confirmados em
 * https://flwchat.readme.io/reference/webhooks-1.md
 * Ate la, este endpoint aceita apenas HMAC-SHA256 sobre o corpo cru.
 *
 * FLUXO (conforme especificado no produto):
 *  1. salvar o evento;
 *  2. identificar o atendimento correspondente;
 *  3. colocar o atendimento na fila de analise;
 *  4. evitar reanalisar a mesma conversa em intervalos muito curtos;
 *  5. atualizar o score apenas quando houver informacao nova relevante.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Teto de tamanho do corpo, para nao aceitar payload arbitrariamente grande. */
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: NextRequest) {
  const env = getEnv();

  /* --- 1. Le o corpo CRU: a assinatura e calculada sobre ele ------------- */
  const rawBody = await request.text();

  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "Payload excede o tamanho maximo aceito." },
      { status: 413 },
    );
  }

  /* --- 2. Verifica a assinatura ------------------------------------------ */
  const signature = request.headers.get(env.webhookSignatureHeader);
  const verification = verifySignature({ rawBody, signatureHeader: signature });

  if (!verification.valid) {
    // Nao detalha o motivo para quem chama: evita ajudar a forjar assinatura.
    console.warn("[webhook] entrega recusada:", verification.reason);
    return NextResponse.json(
      { ok: false, error: "Assinatura invalida." },
      { status: 401 },
    );
  }

  /* --- 3. Interpreta o corpo --------------------------------------------- */
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("corpo nao e um objeto");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON invalido." }, { status: 400 });
  }

  const eventName = readField(payload, ["event", "type", "eventType", "name"]) ?? "DESCONHECIDO";
  const accountId = readField(payload, ["accountId", "account", "tenantId", "companyId"]);
  const sessionId = readField(payload, ["sessionId", "session", "conversationId"]);

  if (!accountId) {
    // Sem conta identificada nao ha como isolar o dado: recusamos.
    return NextResponse.json(
      { ok: false, error: "Evento sem identificacao de conta." },
      { status: 400 },
    );
  }

  /* --- 4. Idempotencia: mesma entrega duas vezes conta como uma ---------- */
  const idempotencyKey =
    readField(payload, ["id", "eventId", "deliveryId"]) ??
    createHash("sha256").update(rawBody).digest("hex");

  const { record, duplicate } = recordWebhookEvent({
    accountId,
    event: eventName,
    idempotencyKey,
    payloadMasked: maskDeep(payload) as Record<string, unknown>,
  });

  if (duplicate) {
    return NextResponse.json(
      { ok: true, status: "duplicado", eventId: record.id },
      { status: 200 },
    );
  }

  /* --- 5. Enfileira a analise, respeitando o debounce -------------------- */
  if (!sessionId) {
    markEventStatus(record.id, "IGNORADO", "Evento sem atendimento associado.");
    return NextResponse.json(
      { ok: true, status: "ignorado", motivo: "sem sessionId" },
      { status: 200 },
    );
  }

  const relevant = isRelevantForAnalysis(eventName);
  const queued = enqueueAnalysis({
    accountId,
    sessionId,
    reason: `Evento ${eventName}`,
    relevantChange: relevant,
  });

  markEventStatus(record.id, queued.scheduled ? "ENFILEIRADO" : "IGNORADO", queued.reason);

  // Responde rapido: o processamento acontece fora do ciclo da requisicao.
  return NextResponse.json(
    {
      ok: true,
      status: queued.scheduled ? "enfileirado" : "ignorado",
      motivo: queued.reason,
      eventId: record.id,
    },
    { status: 202 },
  );
}

/** Le o primeiro campo presente, aceitando variacoes de nome. */
function readField(payload: Record<string, unknown>, names: string[]): string | undefined {
  const lower = new Map(Object.keys(payload).map((k) => [k.toLowerCase(), k]));

  for (const name of names) {
    const actual = lower.get(name.toLowerCase());
    if (actual === undefined) continue;

    const value = payload[actual];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }

  // Alguns provedores aninham os dados em `data` ou `payload`.
  for (const container of ["data", "payload", "body"]) {
    const nested = payload[container];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const found = readField(nested as Record<string, unknown>, names);
      if (found) return found;
    }
  }
  return undefined;
}

/** GET serve apenas para verificar que a rota esta publicada. */
export async function GET() {
  const env = getEnv();
  return NextResponse.json({
    ok: true,
    endpoint: `${env.appBaseUrl}/api/webhooks/klipflowi`,
    signatureHeader: env.webhookSignatureHeader,
    secretConfigured: Boolean(env.webhookSecret),
    aviso: env.webhookSecret
      ? "Endpoint pronto para receber eventos assinados."
      : "FLW_WEBHOOK_SECRET nao configurado: nenhum evento sera aceito.",
  });
}
