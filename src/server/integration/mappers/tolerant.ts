/**
 * Leitores tolerantes de payload.
 *
 * Por que existem: os NOMES DOS CAMPOS devolvidos pela API ainda nao foram
 * confirmados campo a campo na documentacao. Em vez de assumir um nome e
 * quebrar em producao, cada mapper tenta uma lista de nomes plausiveis e
 * REGISTRA qual encontrou (ou que nao encontrou nenhum).
 *
 * Quando a documentacao for confirmada, troque as listas por um unico nome.
 * Nada aqui inventa dados: se o campo nao existir, o resultado e `undefined`
 * e a pendencia e reportada ao chamador.
 */

export interface FieldTrace {
  /** Campo de dominio que se tentou preencher. */
  target: string;
  /** Nomes testados no payload. */
  tried: string[];
  /** Nome efetivamente encontrado, quando houve. */
  resolved?: string;
}

export class MappingReport {
  readonly traces: FieldTrace[] = [];

  record(trace: FieldTrace): void {
    this.traces.push(trace);
  }

  /** Campos de dominio que nao puderam ser preenchidos. */
  get unresolved(): string[] {
    return this.traces.filter((t) => !t.resolved).map((t) => t.target);
  }

  get hasUnresolved(): boolean {
    return this.unresolved.length > 0;
  }

  /** Mensagens legiveis para o campo `pendingValidation` das respostas. */
  toPendingMessages(entity: string): string[] {
    if (!this.hasUnresolved) return [];
    return [
      `${entity}: campos nao encontrados no payload (${this.unresolved.join(", ")}). ` +
        `Confirme os nomes reais na documentacao e ajuste o mapper.`,
    ];
  }
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Busca o primeiro nome presente, comparando tambem em camelCase/PascalCase. */
function lookup(payload: unknown, names: string[]): { value: unknown; key?: string } {
  if (!isRecord(payload)) return { value: undefined };

  const keys = Object.keys(payload);
  const lowerMap = new Map(keys.map((k) => [k.toLowerCase(), k]));

  for (const name of names) {
    const actual = lowerMap.get(name.toLowerCase());
    if (actual !== undefined) {
      const value = payload[actual];
      if (value !== undefined && value !== null) return { value, key: actual };
    }
  }
  return { value: undefined };
}

export function readString(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): string | undefined {
  const { value, key } = lookup(payload, names);
  report?.record({ target, tried: names, resolved: key });

  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function readNumber(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): number | undefined {
  const { value, key } = lookup(payload, names);
  report?.record({ target, tried: names, resolved: key });

  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readBoolean(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): boolean | undefined {
  const { value, key } = lookup(payload, names);
  report?.record({ target, tried: names, resolved: key });

  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Normaliza datas para ISO 8601. Devolve undefined se nao for data valida. */
export function readDate(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): string | undefined {
  const raw = readString(payload, names, target, report);
  if (!raw) return undefined;

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function readArray(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): unknown[] {
  const { value, key } = lookup(payload, names);
  report?.record({ target, tried: names, resolved: key });
  return Array.isArray(value) ? value : [];
}

export function readRecord(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): Rec | undefined {
  const { value, key } = lookup(payload, names);
  report?.record({ target, tried: names, resolved: key });
  return isRecord(value) ? value : undefined;
}

/**
 * Extrai uma lista de ids a partir de um array que pode conter strings
 * ou objetos com um campo de id.
 */
export function readIdList(
  payload: unknown,
  names: string[],
  target: string,
  report?: MappingReport,
): string[] {
  const items = readArray(payload, names, target, report);
  const ids: string[] = [];

  for (const item of items) {
    if (typeof item === "string") {
      ids.push(item);
    } else if (isRecord(item)) {
      const id = readString(item, ["id", "tagId", "value"], `${target}.id`);
      if (id) ids.push(id);
    }
  }
  return ids;
}
