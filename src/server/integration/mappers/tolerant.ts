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

  /**
   * Campos de dominio que nao puderam ser preenchidos, SEM repeticao.
   *
   * O relatorio recebe um registro por campo e por REGISTRO lido. Ao mapear
   * 500 conversas, um campo ausente em todas aparecia 500 vezes: a resposta
   * da Central chegou a 260 KB, quase toda feita da mesma frase repetida.
   * Um nome de campo faltando e um fato, nao quinhentos.
   */
  get unresolved(): string[] {
    const vistos = new Set<string>();
    for (const trace of this.traces) {
      if (!trace.resolved) vistos.add(trace.target);
    }
    return [...vistos];
  }

  /**
   * Quantos registros ficaram sem cada campo, e em quantos ele foi lido.
   *
   * A contagem e o que separa "o mapeador esta errado" de "este campo e
   * opcional e muitos registros nao o tem". Sem ela, os dois casos produzem
   * exatamente a mesma mensagem.
   */
  get unresolvedStats(): { target: string; ausente: number; presente: number }[] {
    const ausente = new Map<string, number>();
    const presente = new Map<string, number>();

    for (const trace of this.traces) {
      const mapa = trace.resolved ? presente : ausente;
      mapa.set(trace.target, (mapa.get(trace.target) ?? 0) + 1);
    }

    return [...ausente.entries()]
      .map(([target, faltas]) => ({
        target,
        ausente: faltas,
        presente: presente.get(target) ?? 0,
      }))
      .sort((a, b) => b.ausente - a.ausente);
  }

  get hasUnresolved(): boolean {
    return this.unresolved.length > 0;
  }

  /** Mensagens legiveis para o campo `pendingValidation` das respostas. */
  toPendingMessages(entity: string): string[] {
    const stats = this.unresolvedStats;
    if (stats.length === 0) return [];

    /*
     * Um campo que aparece em ALGUNS registros e opcional, nao um erro de
     * mapeamento: uma conversa sem atendente nao tem `agentDetails`, e uma
     * nunca respondida nao tem `firstResponseAt`. Dizer ao instalador para
     * "confirmar o nome na documentacao" nesses casos e mandar procurar um
     * problema que nao existe.
     */
    const opcionais = stats.filter((s) => s.presente > 0);
    const ausentesSempre = stats.filter((s) => s.presente === 0);

    const mensagens: string[] = [];

    if (ausentesSempre.length > 0) {
      mensagens.push(
        `${entity}: campos nao encontrados em nenhum registro ` +
          `(${ausentesSempre.map((s) => s.target).join(", ")}). ` +
          `Confirme os nomes reais na documentacao e ajuste o mapper.`,
      );
    }

    if (opcionais.length > 0) {
      mensagens.push(
        `${entity}: campos ausentes em parte dos registros — provavelmente ` +
          `opcionais (${opcionais
            .map((s) => `${s.target}: ${s.ausente} sem, ${s.presente} com`)
            .join("; ")}).`,
      );
    }

    return mensagens;
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
