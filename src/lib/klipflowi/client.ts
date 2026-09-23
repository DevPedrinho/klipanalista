/**
 * Cliente HTTP da API KlipFlowi (https://api.wts.chat).
 * Repete 408/429/5xx com backoff e respeita Retry-After.
 * Veja docs/api-klipflowi.md para o que já foi medido na API.
 */

export class KlipflowiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly corpo: unknown,
  ) {
    super(message);
    this.name = "KlipflowiError";
  }
}

export interface ClienteConfig {
  baseUrl: string;
  token: string;
  tentativas?: number;
  /** Troca o fetch/sleep nos testes. */
  fetchImpl?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | undefined>;

export interface Requisicao {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
}

export interface Pagina<T> {
  items: T[];
  totalPages: number;
  totalItems: number;
}

export const TAMANHO_PAGINA = 50;

const dormirPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function criarCliente(config: ClienteConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const dormir = config.dormir ?? dormirPadrao;
  const tentativas = config.tentativas ?? 4;

  async function request<T>(caminho: string, req: Requisicao = {}): Promise<T> {
    const url = new URL(caminho, config.baseUrl);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let tentativa = 1; ; tentativa++) {
      const resposta = await fetchImpl(url, {
        method: req.method ?? "GET",
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        cache: "no-store",
      });

      const texto = await resposta.text();
      let corpo: unknown = texto;
      try {
        corpo = texto ? JSON.parse(texto) : null;
      } catch {
        // corpo não-JSON: mantém o texto
      }

      if (resposta.ok) return corpo as T;

      const repetivel = resposta.status === 408 || resposta.status === 429 || resposta.status >= 500;
      if (repetivel && tentativa < tentativas) {
        await dormir(esperaAntesDeRepetir(resposta.headers.get("retry-after"), tentativa));
        continue;
      }

      throw new KlipflowiError(
        `KlipFlowi ${req.method ?? "GET"} ${url.pathname} → ${resposta.status}: ${resumirErro(corpo)}`,
        resposta.status,
        corpo,
      );
    }
  }

  /** Uma página no formato {items, totalPages, totalItems}. */
  async function pagina<T>(caminho: string, numero: number, query: Query = {}): Promise<Pagina<T>> {
    const corpo = await request<unknown>(caminho, {
      query: { ...query, pageNumber: numero, pageSize: TAMANHO_PAGINA },
    });
    return lerPagina<T>(corpo);
  }

  /** Todas as páginas, da 1 em diante, até vir incompleta ou repetida. */
  async function todasAsPaginas<T extends { id?: unknown }>(
    caminho: string,
    query: Query = {},
    maxPaginas = 40,
  ): Promise<T[]> {
    const itens: T[] = [];
    const vistos = new Set<string>();
    for (let n = 1; n <= maxPaginas; n++) {
      const p = await pagina<T>(caminho, n, query);
      let novos = 0;
      for (const item of p.items) {
        const chave = String(item.id ?? `${n}:${novos}`);
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        itens.push(item);
        novos++;
      }
      if (p.items.length < TAMANHO_PAGINA || novos === 0) break;
    }
    return itens;
  }

  return { request, pagina, todasAsPaginas };
}

export type ClienteKlipflowi = ReturnType<typeof criarCliente>;

export function lerPagina<T>(corpo: unknown): Pagina<T> {
  if (Array.isArray(corpo)) return { items: corpo as T[], totalPages: 1, totalItems: corpo.length };
  const r = (corpo ?? {}) as Record<string, unknown>;
  const items = Array.isArray(r.items) ? (r.items as T[]) : [];
  return {
    items,
    totalPages: typeof r.totalPages === "number" ? r.totalPages : 1,
    totalItems: typeof r.totalItems === "number" ? r.totalItems : items.length,
  };
}

export function esperaAntesDeRepetir(retryAfter: string | null, tentativa: number): number {
  const segundos = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1000, 10_000);
  return Math.min(500 * 2 ** (tentativa - 1), 5_000) + Math.floor(Math.random() * 250);
}

function resumirErro(corpo: unknown): string {
  if (typeof corpo === "string") return corpo.slice(0, 300);
  try {
    return JSON.stringify(corpo).slice(0, 300);
  } catch {
    return "sem corpo";
  }
}
