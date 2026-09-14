import type { Priority } from "@/domain/enums";

/** Formatadores compartilhados pela interface. */

export function brl(value?: number | null): string {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

export function brlExact(value?: number | null): string {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function compactNumber(value: number): string {
  return value.toLocaleString("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
}

/** "há 3 dias", "há 5 h", "agora". */
export function timeAgo(iso: string, now = Date.now()): string {
  const diffMs = now - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return "—";
  if (diffMs < 60_000) return "agora";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `há ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `há ${days} dia${days > 1 ? "s" : ""}`;

  const months = Math.floor(days / 30);
  return `há ${months} ${months > 1 ? "meses" : "mês"}`;
}

export function dateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

/** Horas -> "3d 4h" */
export function humanHours(hours: number): string {
  if (hours < 1) return "menos de 1 h";
  if (hours < 24) return `${Math.floor(hours)} h`;

  const days = Math.floor(hours / 24);
  const rest = Math.floor(hours % 24);
  return rest > 0 ? `${days}d ${rest}h` : `${days} dia${days > 1 ? "s" : ""}`;
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  CRITICA: "Crítica",
  ALTA: "Alta",
  MEDIA: "Média",
  BAIXA: "Baixa",
};

/** Classes de cor por prioridade, coerentes com a identidade azul/roxo. */
export const PRIORITY_CLASSES: Record<Priority, string> = {
  CRITICA: "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:ring-rose-900",
  ALTA: "bg-violet-brand-100 text-violet-brand-800 ring-violet-brand-200 dark:bg-violet-brand-900/40 dark:text-violet-brand-200 dark:ring-violet-brand-800",
  MEDIA: "bg-flowi-100 text-flowi-800 ring-flowi-200 dark:bg-flowi-900/40 dark:text-flowi-200 dark:ring-flowi-800",
  BAIXA: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:ring-slate-700",
};

/** Cor da barra de score. */
export function scoreColor(score: number): string {
  if (score >= 75) return "bg-violet-brand-600";
  if (score >= 50) return "bg-flowi-600";
  return "bg-slate-400 dark:bg-slate-600";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

/** Junta classes ignorando valores falsy. */
export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}
