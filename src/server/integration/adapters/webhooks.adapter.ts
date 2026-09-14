import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/server/config/env";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import { MappingReport, readArray, readBoolean, readString } from "../mappers/tolerant";
import {
  buildIdempotencyKey,
  liveResult,
  mockResult,
  shouldUseMock,
  type AdapterResult,
} from "./base";

/**
 * WebhooksAdapter — assinaturas de webhook.
 *
 * Endpoints CONFIRMADOS:
 *   GET    /v1/webhook/event                        Eventos assinaveis
 *   GET    /v1/webhook/subscription                 Listar assinaturas
 *   POST   /v1/webhook/subscription                 Criar assinatura
 *   PUT    /v1/webhook/subscription/{id}            Atualizar
 *   DELETE /v1/webhook/subscription/{id}            Remover
 *
 * PENDENTE DE VALIDACAO (critico para seguranca):
 *   O nome do header de assinatura e o algoritmo usado pela KlipFlowi para
 *   assinar os webhooks NAO constam do indice. Fonte a confirmar:
 *   https://flwchat.readme.io/reference/webhooks-1.md
 *
 *   Enquanto isso, `verifySignature` implementa HMAC-SHA256 sobre o corpo
 *   cru e FALHA FECHADO: sem segredo configurado, nenhum webhook e aceito.
 */

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

/**
 * Verifica a assinatura de um webhook recebido.
 *
 * Falha fechado de proposito: um endpoint de webhook sem verificacao aceita
 * eventos forjados de qualquer origem.
 */
export function verifySignature(params: {
  rawBody: string;
  signatureHeader: string | null;
}): { valid: boolean; reason?: string } {
  const env = getEnv();

  if (!env.webhookSecret) {
    return {
      valid: false,
      reason:
        "FLW_WEBHOOK_SECRET nao configurado. Nenhum webhook e aceito ate que " +
        "o segredo esteja definido.",
    };
  }

  if (!params.signatureHeader) {
    return {
      valid: false,
      reason: `Header de assinatura "${env.webhookSignatureHeader}" ausente na requisicao.`,
    };
  }

  // PENDENTE: confirmar se a KlipFlowi assina o corpo cru com HMAC-SHA256
  // em hex, e se o header traz prefixo (ex.: "sha256=").
  const received = params.signatureHeader.replace(/^sha256=/i, "").trim();
  const expected = createHmac("sha256", env.webhookSecret)
    .update(params.rawBody, "utf8")
    .digest("hex");

  const receivedBuf = Buffer.from(received, "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (receivedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: "Assinatura com tamanho inesperado." };
  }

  // Comparacao em tempo constante: evita ataque de temporizacao.
  const valid = timingSafeEqual(receivedBuf, expectedBuf);
  return valid ? { valid: true } : { valid: false, reason: "Assinatura invalida." };
}

export const webhooksAdapter = {
  /** Eventos que a conta pode assinar, segundo a propria API. */
  async listAvailableEvents(): Promise<AdapterResult<string[]>> {
    if (shouldUseMock()) {
      return mockResult(
        [
          "SESSION_NEW", "SESSION_UPDATE", "SESSION_COMPLETE",
          "MESSAGE_RECEIVED", "MESSAGE_SENT",
          "CONTACT_NEW", "CONTACT_UPDATE", "CONTACT_TAG_UPDATE",
          "PANEL_CARD_NEW", "PANEL_CARD_UPDATE", "PANEL_CARD_STEP_CHANGE",
          "PANEL_CARD_NOTE_NEW", "PANEL_CARD_NOTE_UPDATE",
        ],
        [
          "Lista vinda do briefing do produto, nao da API. Os nomes reais devem " +
            "ser lidos de GET /v1/webhook/event antes de criar assinaturas.",
        ],
      );
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(ENDPOINTS.WEBHOOKS.LIST_EVENTS, {}, {}, 3);

    const events: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") events.push(item);
      else {
        const name = readString(item, ["name", "event", "key", "type"], "webhookEvent.name", report);
        if (name) events.push(name);
      }
    }
    return liveResult(events, report, "Evento de webhook");
  },

  async listSubscriptions(): Promise<AdapterResult<WebhookSubscription[]>> {
    if (shouldUseMock()) {
      return mockResult([], ["Nenhuma assinatura simulada: consulte a API real para ver as ativas."]);
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(ENDPOINTS.WEBHOOKS.LIST_SUBSCRIPTIONS, {}, {}, 3);

    const subs = raw
      .map((item): WebhookSubscription | null => {
        const id = readString(item, ["id", "subscriptionId"], "subscription.id", report);
        const url = readString(item, ["url", "callbackUrl", "endpoint"], "subscription.url", report);
        if (!id || !url) return null;

        const eventsRaw = readArray(item, ["events", "eventTypes"], "subscription.events", report);
        return {
          id,
          url,
          events: eventsRaw.filter((e): e is string => typeof e === "string"),
          active: readBoolean(item, ["active", "enabled"], "subscription.active", report) ?? true,
        };
      })
      .filter((s): s is WebhookSubscription => s !== null);

    return liveResult(subs, report, "Assinatura de webhook");
  },

  /**
   * Cria a assinatura apontando para este modulo.
   *
   * NAO e chamado automaticamente: registrar webhooks e uma acao de
   * configuracao, feita conscientemente por um administrador.
   */
  async createSubscription(params: {
    accountId: string;
    events: string[];
    dryRun: boolean;
  }): Promise<AdapterResult<WebhookSubscription | null>> {
    const env = getEnv();
    const contract = ENDPOINTS.WEBHOOKS.CREATE_SUBSCRIPTION;
    const callbackUrl = `${env.appBaseUrl}/api/webhooks/klipflowi`;

    if (params.dryRun || shouldUseMock()) {
      return mockResult(
        { id: "sub_simulada", url: callbackUrl, events: params.events, active: true },
        ["Simulacao: nenhuma assinatura foi criada.", ...contract.pending],
      );
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(contract, {
      body: { url: callbackUrl, events: params.events },
      idempotencyKey: buildIdempotencyKey({
        accountId: params.accountId,
        actionType: "CRIAR_WEBHOOK",
        targetId: callbackUrl,
      }),
    });

    const id = readString(response.data, ["id", "subscriptionId"], "subscription.id", report);
    return liveResult(
      id ? { id, url: callbackUrl, events: params.events, active: true } : null,
      report,
      "Assinatura de webhook",
    );
  },
};
