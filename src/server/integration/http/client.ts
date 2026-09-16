import "server-only";
import { getEnv } from "@/server/config/env";
import { scrubSecrets } from "@/server/security/masking";
import {
  resolvePath,
  type ApiGroup,
  type EndpointContract,
} from "@/server/integration/endpoints";
import { getRateLimiter } from "./rate-limiter";

/**
 * Cliente HTTP unico para a API KlipFlowi.
 *
 * Responsabilidades:
 *  - injetar o token permanente (somente no servidor);
 *  - respeitar rate limit, concorrencia e 429;
 *  - repetir com backoff exponencial e jitter;
 *  - garantir idempotencia em escritas;
 *  - impedir chamadas a contratos ainda nao validados.
 *
 * AUTENTICACAO — CONFIRMADO na documentacao oficial:
 *   Header `Authorization: Bearer pn_...`
 *   Token gerado em Configuracoes > Integracoes > Integracao API.
 */

export type ApiFailureKind =
  | "SEM_INTEGRACAO"
  | "CONTRATO_NAO_VALIDADO"
  | "NAO_AUTENTICADO"
  | "SEM_PERMISSAO"
  | "LIMITE_REQUISICOES"
  | "NAO_ENCONTRADO"
  | "CONFLITO_DADOS"
  | "ERRO_API"
  | "TIMEOUT"
  | "ERRO_REDE";

export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly statusCode?: number;
  readonly endpointKey: string;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(params: {
    kind: ApiFailureKind;
    message: string;
    endpointKey: string;
    statusCode?: number;
    retryAfterMs?: number;
    details?: unknown;
  }) {
    super(scrubSecrets(params.message));
    this.name = "ApiError";
    this.kind = params.kind;
    this.statusCode = params.statusCode;
    this.endpointKey = params.endpointKey;
    this.retryAfterMs = params.retryAfterMs;
    this.details = params.details;
  }
}

export interface RequestOptions {
  /** Substituicoes dos placeholders `{nome}` do caminho. */
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Chave de idempotencia. Obrigatoria em POST/PUT/DELETE disparados pela IA,
   * para que um retry nunca duplique uma escrita.
   *
   * PENDENTE DE VALIDACAO: confirmar se a API honra o header
   * `Idempotency-Key`. Enquanto nao confirmado, a chave tambem e usada
   * internamente para deduplicar retries no proprio cliente.
   */
  idempotencyKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 4;

function baseUrlFor(group: ApiGroup): string | undefined {
  const env = getEnv();
  switch (group) {
    case "core":
      return env.coreApiUrl;
    case "chat":
      return env.chatApiUrl;
    case "crm":
      // Paineis e cards. Sem FLW_CRM_API_URL definida, recai sobre o core.
      return env.crmApiUrl ?? env.coreApiUrl;
    case "auth":
      // Sem FLW_AUTH_API_URL, o grupo auth recai sobre o core.
      return env.authApiUrl ?? env.coreApiUrl;
  }
}

function buildQuery(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Requisicao cancelada."));
      },
      { once: true },
    );
  });
}

/** Backoff exponencial 2s, 4s, 8s, 16s com jitter de ate 30%. */
function backoffDelay(attempt: number): number {
  const base = 2000 * 2 ** attempt;
  const jitter = base * 0.3 * Math.random();
  return Math.min(30_000, base + jitter);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}

function kindForStatus(status: number): ApiFailureKind {
  if (status === 401) return "NAO_AUTENTICADO";
  if (status === 403) return "SEM_PERMISSAO";
  if (status === 404) return "NAO_ENCONTRADO";
  if (status === 409) return "CONFLITO_DADOS";
  if (status === 429) return "LIMITE_REQUISICOES";
  return "ERRO_API";
}

/** Somente estes status justificam nova tentativa. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Barreira de seguranca: um contrato com pendencias que afetem o CAMINHO
 * nao pode ser chamado sem confirmacao explicita via variavel de ambiente.
 * Evita disparar requisicoes contra URLs inventadas.
 */
function assertCallable(contract: EndpointContract): void {
  const hasOverride = Boolean(process.env[`FLW_EP_${contract.key}`]);
  if (hasOverride) return;

  if (contract.path.length === 0) {
    throw new ApiError({
      kind: "CONTRATO_NAO_VALIDADO",
      endpointKey: contract.key,
      message:
        `O endpoint ${contract.key} nao tem caminho conhecido. ` +
        `Pendencias: ${contract.pending.join(" | ")}. ` +
        `Confirme na documentacao e defina FLW_EP_${contract.key}.`,
      details: { pending: contract.pending },
    });
  }
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  /** Headers uteis (paginacao, rate limit) preservados para os adapters. */
  headers: Record<string, string>;
}

export async function apiRequest<T>(
  contract: EndpointContract,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const env = getEnv();

  if (!env.apiToken) {
    throw new ApiError({
      kind: "SEM_INTEGRACAO",
      endpointKey: contract.key,
      message: "FLW_API_TOKEN nao configurado. Configure a integracao no .env.local.",
    });
  }

  const base = baseUrlFor(contract.group);
  if (!base) {
    throw new ApiError({
      kind: "SEM_INTEGRACAO",
      endpointKey: contract.key,
      message:
        `URL base do grupo "${contract.group}" nao configurada. ` +
        `Defina FLW_${contract.group.toUpperCase()}_API_URL com o valor do ` +
        `campo servers do OpenAPI correspondente.`,
    });
  }

  assertCallable(contract);

  const path = resolvePath(contract, options.pathParams);
  const url = `${base}${path}${buildQuery(options.query)}`;
  const limiter = getRateLimiter(contract.group);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isWrite = contract.method !== "GET";
  if (isWrite && !options.idempotencyKey) {
    throw new ApiError({
      kind: "ERRO_API",
      endpointKey: contract.key,
      message:
        `Escrita em ${contract.key} exige idempotencyKey. ` +
        `Toda acao da IA precisa ser reproduzivel sem duplicar efeitos.`,
    });
  }

  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const release = await limiter.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${env.apiToken}`,
        Accept: "application/json",
      };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

      const response = await fetch(url, {
        method: contract.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: "no-store",
      });

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

      if (response.status === 429) {
        // Pausa a fila inteira do grupo, nao apenas esta chamada.
        limiter.pauseFor(retryAfterMs ?? backoffDelay(attempt));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new ApiError({
          kind: kindForStatus(response.status),
          statusCode: response.status,
          endpointKey: contract.key,
          retryAfterMs,
          message: `${contract.method} ${contract.key} respondeu ${response.status}. ${text.slice(0, 400)}`,
        });

        if (isRetryable(response.status) && attempt < maxRetries) {
          release();
          clearTimeout(timer);
          await sleep(retryAfterMs ?? backoffDelay(attempt), options.signal);
          continue;
        }
        throw lastError;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = key.toLowerCase() === "authorization" ? "[mascarado]" : value;
      });

      const raw = await response.text();
      const data = raw.length > 0 ? (JSON.parse(raw) as T) : (undefined as T);

      return { data, status: response.status, headers: responseHeaders };
    } catch (error) {
      if (error instanceof ApiError) throw error;

      const aborted = error instanceof Error && error.name === "AbortError";
      lastError = new ApiError({
        kind: aborted ? "TIMEOUT" : "ERRO_REDE",
        endpointKey: contract.key,
        message: aborted
          ? `Tempo esgotado (${timeoutMs}ms) em ${contract.key}.`
          : `Falha de rede em ${contract.key}: ${(error as Error).message}`,
      });

      if (attempt < maxRetries) {
        release();
        clearTimeout(timer);
        await sleep(backoffDelay(attempt), options.signal);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      release();
    }
  }

  throw (
    lastError ??
    new ApiError({
      kind: "ERRO_API",
      endpointKey: contract.key,
      message: `Falha desconhecida em ${contract.key}.`,
    })
  );
}

/**
 * Percorre todas as paginas de um endpoint de listagem.
 *
 * PENDENTE DE VALIDACAO: o formato de paginacao (nomes dos parametros e onde
 * vem o total) precisa ser confirmado em
 * https://flwchat.readme.io/reference/paginação.md
 * Os nomes abaixo sao configuraveis justamente por isso.
 */
export interface PaginationConfig {
  pageParam: string;
  sizeParam: string;
  pageSize: number;
  /** Le os itens do corpo da resposta. */
  extractItems: (payload: unknown) => unknown[];
  /** Diz se ha proxima pagina. */
  hasNext: (payload: unknown, received: number, pageSize: number) => boolean;
  /** Primeira pagina: algumas APIs comecam em 0, outras em 1. */
  firstPage: number;
}

export const DEFAULT_PAGINATION: PaginationConfig = {
  pageParam: "page",
  sizeParam: "pageSize",
  pageSize: 50,
  firstPage: 1,
  extractItems: (payload) => {
    if (Array.isArray(payload)) return payload;
    const record = payload as Record<string, unknown> | null;
    if (!record) return [];
    for (const key of ["items", "data", "results", "content", "records"]) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  },
  hasNext: (_payload, received, pageSize) => received === pageSize,
};

export async function apiRequestAllPages<T>(
  contract: EndpointContract,
  options: RequestOptions = {},
  pagination: Partial<PaginationConfig> = {},
  maxPages = 20,
): Promise<T[]> {
  const config = { ...DEFAULT_PAGINATION, ...pagination };
  const collected: T[] = [];

  for (let index = 0; index < maxPages; index += 1) {
    const page = config.firstPage + index;

    const response = await apiRequest<unknown>(contract, {
      ...options,
      query: {
        ...options.query,
        [config.pageParam]: page,
        [config.sizeParam]: config.pageSize,
      },
    });

    const items = config.extractItems(response.data) as T[];
    collected.push(...items);

    if (!config.hasNext(response.data, items.length, config.pageSize)) break;
  }

  return collected;
}
