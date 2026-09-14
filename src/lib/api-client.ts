import type { ApiEnvelope, ApiErrorBody } from "@/domain/types";

/**
 * Cliente HTTP do frontend.
 *
 * Fala APENAS com as rotas internas /api/*. Nunca com a API da KlipFlowi:
 * o token permanente vive somente no servidor.
 */

export class ClientApiError extends Error {
  readonly body: ApiErrorBody;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ClientApiError";
    this.body = body;
  }
}

async function parse<T>(response: Response): Promise<T> {
  let envelope: ApiEnvelope<T>;

  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ClientApiError({
      code: "ERRO_INTERNO",
      message: `Resposta inválida do servidor (HTTP ${response.status}).`,
    });
  }

  if (!envelope.ok) throw new ClientApiError(envelope.error);
  return envelope.data;
}

export async function apiGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }

  const response = await fetch(`${path}?${search.toString()}`, {
    method: "GET",
    signal,
    headers: { Accept: "application/json" },
  });

  return parse<T>(response);
}

export async function apiSend<T>(
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  return parse<T>(response);
}

/** Converte qualquer erro capturado em um corpo de erro exibivel. */
export function toErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof ClientApiError) return error.body;

  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "ERRO_INTERNO", message: "Requisição cancelada." };
  }

  return {
    code: "ERRO_INTERNO",
    message:
      error instanceof Error
        ? error.message
        : "Não foi possível concluir a solicitação.",
  };
}
