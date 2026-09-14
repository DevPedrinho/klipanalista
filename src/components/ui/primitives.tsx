"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/format";

/**
 * Kit de componentes reutilizaveis do Flowi Copilot Comercial.
 *
 * Usa exclusivamente os tokens definidos em globals.css, para que o modulo
 * acompanhe a identidade da KlipFlowi (azul, roxo e branco) e responda ao
 * tema claro/escuro sem ajustes por tela.
 */

/* ==========================================================================
   Card
   ========================================================================== */
export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag
      className={cx(
        "rounded-xl border border-border-subtle bg-surface-card",
        "shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/* ==========================================================================
   Button
   ========================================================================== */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "flowi-gradient text-white hover:opacity-90 disabled:opacity-50 shadow-sm",
  secondary:
    "border border-border-strong bg-surface-card text-text-primary hover:bg-surface-muted disabled:opacity-50",
  ghost: "text-text-secondary hover:bg-surface-muted hover:text-text-primary disabled:opacity-50",
  subtle:
    "bg-flowi-50 text-flowi-700 hover:bg-flowi-100 disabled:opacity-50 dark:bg-flowi-900/40 dark:text-flowi-200 dark:hover:bg-flowi-900/60",
  danger:
    "border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ref,
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  // React 19 trata `ref` como prop normal em componentes de funcao.
  ref?: React.Ref<HTMLButtonElement>;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-medium",
        "transition-colors disabled:cursor-not-allowed",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ==========================================================================
   Badge
   ========================================================================== */
export function Badge({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
        "text-[11px] font-medium ring-1 ring-inset",
        className ??
          "bg-surface-muted text-text-secondary ring-border-subtle",
      )}
    >
      {children}
    </span>
  );
}

/* ==========================================================================
   Barra de score
   ========================================================================== */
export function ScoreBar({
  value,
  colorClass,
  label,
}: {
  value: number;
  colorClass: string;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset"
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? "Score"}
      >
        <div
          className={cx("h-full rounded-full transition-all", colorClass)}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-text-secondary">
        {Math.round(clamped)}
      </span>
    </div>
  );
}

/* ==========================================================================
   Estados de interface
   ========================================================================== */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("flowi-skeleton", className)} aria-hidden="true" />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-text-muted">
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

type NoticeTone = "info" | "warning" | "danger" | "success" | "pending";

const NOTICE_TONES: Record<NoticeTone, string> = {
  info: "border-flowi-200 bg-flowi-50 text-flowi-900 dark:border-flowi-800 dark:bg-flowi-950/40 dark:text-flowi-100",
  warning:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  danger:
    "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
  pending:
    "border-violet-brand-200 bg-violet-brand-50 text-violet-brand-900 dark:border-violet-brand-800 dark:bg-violet-brand-950/40 dark:text-violet-brand-100",
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cx("rounded-xl border px-4 py-3 text-sm", NOTICE_TONES[tone])}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          <div className={cx("text-[13px] leading-relaxed", title ? "mt-1 opacity-90" : undefined)}>
            {children}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

/* ==========================================================================
   Campos de formulario
   ========================================================================== */
export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-text-secondary"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-text-muted">{hint}</p> : null}
    </div>
  );
}

const CONTROL_CLASS =
  "h-9 w-full rounded-lg border border-border-strong bg-surface-card px-3 text-sm " +
  "text-text-primary placeholder:text-text-muted disabled:opacity-60";

export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(CONTROL_CLASS, "pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL_CLASS, className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        "w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2",
        "text-sm text-text-primary placeholder:text-text-muted",
        className,
      )}
      {...rest}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-3",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cx(
          "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
          checked ? "flowi-gradient" : "bg-border-strong",
        )}
      >
        <span
          className={cx(
            "block h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-4",
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-text-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
