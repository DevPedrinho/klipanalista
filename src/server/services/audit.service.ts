import "server-only";
import type { ActionStatus, ActionType, AutomationMode } from "@/domain/enums";
import type { AuditLogEntry } from "@/domain/types";
import { maskDeep } from "@/server/security/masking";

/**
 * Registro de auditoria.
 *
 * Armazenamento: em memoria nesta primeira entrega. A interface e a mesma
 * que um repositorio de banco teria — ver db/migrations/0001_init.sql,
 * tabela `audit_logs` — entao a troca nao afeta os chamadores.
 *
 * Tudo o que a IA sugere ou executa passa por aqui. Nao ha caminho de
 * escrita no modulo que nao gere um registro.
 */

const store: AuditLogEntry[] = [];

/** Teto de registros em memoria, para o processo nao crescer sem limite. */
const MAX_ENTRIES = 5000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `audit_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export interface RecordAuditInput {
  accountId: string;
  requestedByUserId: string;
  requestedByName: string;
  actionType: ActionType;
  actionStatus: ActionStatus;
  targetKind: AuditLogEntry["targetKind"];
  targetId: string;
  targetLabel: string;
  suggestion: string;
  evidenceCodes: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  aiConfidence: number;
  automationMode: AutomationMode;
  apiResult?: AuditLogEntry["apiResult"];
  success: boolean;
  approvedByUserId?: string;
  approvedByName?: string;
}

export function recordAudit(input: RecordAuditInput): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: nextId(),
    accountId: input.accountId,
    requestedByUserId: input.requestedByUserId,
    requestedByName: input.requestedByName,
    occurredAt: new Date().toISOString(),
    actionType: input.actionType,
    actionStatus: input.actionStatus,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetLabel: input.targetLabel,
    suggestion: input.suggestion,
    evidenceCodes: input.evidenceCodes,
    // Estados anterior e posterior sao mascarados: auditoria nao e lugar
    // para telefone e e-mail em texto puro.
    before: input.before ? (maskDeep(input.before) as Record<string, unknown>) : null,
    after: input.after ? (maskDeep(input.after) as Record<string, unknown>) : null,
    aiConfidence: input.aiConfidence,
    automationMode: input.automationMode,
    apiResult: input.apiResult ?? null,
    success: input.success,
    approvedByUserId: input.approvedByUserId,
    approvedByName: input.approvedByName,
    approvedAt: input.approvedByUserId ? new Date().toISOString() : undefined,
  };

  store.unshift(entry);
  if (store.length > MAX_ENTRIES) store.length = MAX_ENTRIES;

  return entry;
}

export interface AuditQuery {
  accountId: string;
  actionType?: ActionType;
  actionStatus?: ActionStatus;
  requestedByUserId?: string;
  targetId?: string;
  /** ISO 8601. */
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  entries: AuditLogEntry[];
  total: number;
}

export function queryAudit(query: AuditQuery): AuditPage {
  // O filtro por accountId vem primeiro e nao e opcional: e o isolamento
  // entre contas, nao uma conveniencia de busca.
  let rows = store.filter((e) => e.accountId === query.accountId);

  if (query.actionType) rows = rows.filter((e) => e.actionType === query.actionType);
  if (query.actionStatus) rows = rows.filter((e) => e.actionStatus === query.actionStatus);
  if (query.requestedByUserId) rows = rows.filter((e) => e.requestedByUserId === query.requestedByUserId);
  if (query.targetId) rows = rows.filter((e) => e.targetId === query.targetId);
  if (query.from) rows = rows.filter((e) => e.occurredAt >= query.from!);
  if (query.to) rows = rows.filter((e) => e.occurredAt <= query.to!);

  if (query.search) {
    const needle = query.search.toLowerCase();
    rows = rows.filter(
      (e) =>
        e.targetLabel.toLowerCase().includes(needle) ||
        e.suggestion.toLowerCase().includes(needle) ||
        e.requestedByName.toLowerCase().includes(needle),
    );
  }

  const total = rows.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;

  return { entries: rows.slice(offset, offset + limit), total };
}

/**
 * Taxa de aproveitamento: proporcao de sugestoes que viraram acao aplicada,
 * entre as que tiveram um desfecho (aplicada ou rejeitada).
 */
export function suggestionAcceptanceRate(accountId: string): number {
  const rows = store.filter((e) => e.accountId === accountId);

  const executed = rows.filter((e) => e.actionStatus === "EXECUTADA" && e.success).length;
  const rejected = rows.filter(
    (e) => e.actionStatus === "REJEITADA" || e.actionType === "IGNORAR_RECOMENDACAO",
  ).length;

  const decided = executed + rejected;
  if (decided === 0) return 0;

  return Math.round((executed / decided) * 100);
}

/** Apenas para testes e para reiniciar o estado simulado. */
export function clearAudit(): void {
  store.length = 0;
  seq = 0;
}

export function auditCount(accountId: string): number {
  return store.filter((e) => e.accountId === accountId).length;
}
