import "server-only";

/**
 * Controle de concorrencia e vazao para as chamadas a API KlipFlowi.
 *
 * A documentacao oficial declara rate limit por endpoint (ex.: endpoints de
 * envio permitem 1000 requisicoes a cada 2 minutos).
 *
 * PENDENTE DE VALIDACAO: o limite global da conta e os headers de resposta que
 * informam a janela restante ainda precisam ser confirmados em
 * https://flwchat.readme.io/reference/rate-limiting.md
 * Ate la usamos um teto conservador, configuravel.
 */

interface QueueItem {
  run: () => void;
}

export interface RateLimiterOptions {
  /** Requisicoes simultaneas permitidas. */
  maxConcurrent: number;
  /** Quantidade maxima de requisicoes dentro da janela. */
  maxPerWindow: number;
  /** Tamanho da janela em milissegundos. */
  windowMs: number;
}

const DEFAULT_OPTIONS: RateLimiterOptions = {
  maxConcurrent: 4,
  // Teto conservador ate a confirmacao do limite real da conta.
  maxPerWindow: 240,
  windowMs: 60_000,
};

export class RateLimiter {
  private readonly options: RateLimiterOptions;
  private active = 0;
  private readonly queue: QueueItem[] = [];
  /** Timestamps das requisicoes concluidas dentro da janela atual. */
  private timestamps: number[] = [];
  /** Quando != null, todas as chamadas aguardam ate este instante (429). */
  private pausedUntil: number | null = null;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Sinaliza um 429: pausa a fila inteira pelo tempo pedido pelo servidor. */
  pauseFor(ms: number): void {
    const until = Date.now() + ms;
    this.pausedUntil = Math.max(this.pausedUntil ?? 0, until);
  }

  get isPaused(): boolean {
    return this.pausedUntil !== null && Date.now() < this.pausedUntil;
  }

  /** Milissegundos restantes de pausa, 0 quando liberado. */
  get pauseRemainingMs(): number {
    if (this.pausedUntil === null) return 0;
    return Math.max(0, this.pausedUntil - Date.now());
  }

  async acquire(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      this.queue.push({ run: resolve });
      this.drain();
    });

    this.active += 1;
    this.timestamps.push(Date.now());

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.options.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  private drain(): void {
    if (this.queue.length === 0) return;

    if (this.isPaused) {
      setTimeout(() => this.drain(), this.pauseRemainingMs + 10);
      return;
    }
    this.pausedUntil = null;

    this.pruneWindow();

    if (this.active >= this.options.maxConcurrent) return;

    if (this.timestamps.length >= this.options.maxPerWindow) {
      const oldest = this.timestamps[0] ?? Date.now();
      const waitMs = oldest + this.options.windowMs - Date.now();
      setTimeout(() => this.drain(), Math.max(50, waitMs));
      return;
    }

    const next = this.queue.shift();
    if (next) {
      next.run();
      // Continua drenando caso ainda haja folga de concorrencia.
      if (this.queue.length > 0) queueMicrotask(() => this.drain());
    }
  }

  get stats() {
    this.pruneWindow();
    return {
      active: this.active,
      queued: this.queue.length,
      usedInWindow: this.timestamps.length,
      maxPerWindow: this.options.maxPerWindow,
      pausedMs: this.pauseRemainingMs,
    };
  }
}

/** Um limiter por grupo de servico, pois os limites sao independentes. */
const limiters = new Map<string, RateLimiter>();

export function getRateLimiter(group: string): RateLimiter {
  let limiter = limiters.get(group);
  if (!limiter) {
    limiter = new RateLimiter();
    limiters.set(group, limiter);
  }
  return limiter;
}
