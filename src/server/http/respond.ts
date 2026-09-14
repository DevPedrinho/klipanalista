import "server-only";
import { NextResponse } from "next/server";
import type { ApiEnvelope, ApiErrorBody, ResponseMeta } from "@/domain/types";
import { ApiError } from "@/server/integration/http/client";
import { AccessError } from "@/server/security/tenant-context";
import { CardRuleError } from "@/server/integration/adapters/cards.adapter";
import { scrubSecrets } from "@/server/security/masking";

/**
 * Envelope unico de resposta das rotas de API.
 *
 * Duas garantias:
 *  - toda resposta diz se os dados sao simulados ou reais (`dataMode`);
 *  - nenhum erro vaza token, stack trace ou detalhe interno para o cliente.
 */

export function ok<T>(
  data: T,
  meta: Omit<ResponseMeta, "generatedAt"> & { generatedAt?: string },
) {
  const body: ApiEnvelope<T> = {
    ok: true,
    data,
    meta: { ...meta, generatedAt: meta.generatedAt ?? new Date().toISOString() },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

const STATUS_BY_CODE: Record<ApiErrorBody["code"], number> = {
  NAO_AUTENTICADO: 401,
  SEM_PERMISSAO: 403,
  PARAMETROS_INVALIDOS: 400,
  SEM_INTEGRACAO: 503,
  ERRO_API: 502,
  LIMITE_REQUISICOES: 429,
  CONFLITO_DADOS: 409,
  AGUARDANDO_APROVACAO: 202,
  CONTRATO_NAO_VALIDADO: 501,
  ERRO_INTERNO: 500,
};

export function fail(
  code: ApiErrorBody["code"],
  message: string,
  details?: Record<string, unknown>,
) {
  const body: ApiEnvelope<never> = {
    ok: false,
    error: { code, message: scrubSecrets(message), details },
  };
  return NextResponse.json(body, {
    status: STATUS_BY_CODE[code],
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Converte qualquer excecao em uma resposta segura.
 * Erros inesperados viram 500 genericos: a mensagem real fica no log do servidor.
 */
export function handleError(error: unknown) {
  if (error instanceof AccessError) {
    return fail(error.code, error.message);
  }

  if (error instanceof CardRuleError) {
    return fail("CONFLITO_DADOS", error.message);
  }

  if (error instanceof ApiError) {
    switch (error.kind) {
      case "SEM_INTEGRACAO":
        return fail("SEM_INTEGRACAO", error.message);
      case "CONTRATO_NAO_VALIDADO":
        return fail("CONTRATO_NAO_VALIDADO", error.message, { endpoint: error.endpointKey });
      case "NAO_AUTENTICADO":
        return fail("NAO_AUTENTICADO", "Token da API recusado pela KlipFlowi.");
      case "SEM_PERMISSAO":
        return fail("SEM_PERMISSAO", "O token nao tem permissao para este recurso.");
      case "LIMITE_REQUISICOES":
        return fail(
          "LIMITE_REQUISICOES",
          "Limite de requisicoes da API atingido. A fila vai retomar automaticamente.",
          { retryAfterMs: error.retryAfterMs },
        );
      case "CONFLITO_DADOS":
        return fail("CONFLITO_DADOS", error.message);
      default:
        return fail("ERRO_API", error.message, { endpoint: error.endpointKey });
    }
  }

  // Erro nao previsto: registra no servidor, devolve mensagem generica.
  console.error("[api] erro nao tratado:", error);
  return fail("ERRO_INTERNO", "Ocorreu um erro inesperado ao processar a solicitacao.");
}

/** Converte erros do zod em uma resposta de parametros invalidos. */
export function failValidation(
  issues: { path: readonly (string | number | symbol)[]; message: string }[],
) {
  return fail("PARAMETROS_INVALIDOS", "Parametros invalidos na requisicao.", {
    campos: issues.map((i) => ({
      campo: i.path.map(String).join(".") || "(raiz)",
      problema: i.message,
    })),
  });
}
