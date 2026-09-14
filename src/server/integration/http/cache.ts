import "server-only";

/**
 * Cache em memoria com TTL para respostas de leitura.
 *
 * Escopo: processo. Em producao com multiplas instancias, troque a
 * implementacao por Redis mantendo a mesma interface.
 *
 * Toda chave inclui o accountId, para que dados de uma conta jamais
 * possam ser servidos a outra.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Teto de entradas para evitar crescimento indefinido. */
const MAX_ENTRIES = 2000;

export function cacheKey(accountId: string, parts: (string | number | undefined)[]): string {
  return `${accountId}::${parts.filter((p) => p !== undefined).join("::")}`;
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    // Descarta a entrada mais antiga inserida (Map preserva ordem de insercao).
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Invalida todas as entradas de uma conta (apos uma escrita, por exemplo). */
export function cacheInvalidateAccount(accountId: string): number {
  let removed = 0;
  for (const key of store.keys()) {
    if (key.startsWith(`${accountId}::`)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function cacheClear(): void {
  store.clear();
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;

  const value = await producer();
  cacheSet(key, value, ttlMs);
  return value;
}
