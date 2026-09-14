"use client";

import { useEffect, useRef } from "react";
import type { ActionType } from "@/domain/enums";
import type { Opportunity } from "@/domain/types";
import { Button, Notice } from "@/components/ui/primitives";

/**
 * Modal de confirmacao de acao.
 *
 * Mostra o diff proposto (antes -> depois) antes de qualquer mudanca.
 * Nenhuma acao e aplicada sem passar por aqui, exceto as de baixo risco
 * expressamente autorizadas no modo Automatico controlado.
 */

export interface ActionPreview {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  description: string;
  warnings: string[];
}

export interface PendingAction {
  opportunity: Opportunity;
  actionType: ActionType;
  actionLabel: string;
  reason: string;
  preview: ActionPreview;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "sim" : "não";
  return JSON.stringify(value, null, 2);
}

function DiffColumn({
  title,
  data,
  tone,
}: {
  title: string;
  data: Record<string, unknown> | null;
  tone: "before" | "after";
}) {
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </p>
      <div
        className={
          tone === "before"
            ? "rounded-lg border border-border-subtle bg-surface-muted p-3"
            : "rounded-lg border border-flowi-200 bg-flowi-50 p-3 dark:border-flowi-800 dark:bg-flowi-950/40"
        }
      >
        {!data || Object.keys(data).length === 0 ? (
          <p className="text-xs text-text-muted">Nada registrado.</p>
        ) : (
          <dl className="space-y-2">
            {Object.entries(data).map(([key, value]) => (
              <div key={key}>
                <dt className="text-[11px] text-text-muted">{key}</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs font-medium text-text-primary">
                  {renderValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

export function ActionModal({
  pending,
  submitting,
  onConfirm,
  onCancel,
}: {
  pending: PendingAction | null;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Fecha com Escape e devolve o foco ao botao de confirmar ao abrir.
  useEffect(() => {
    if (!pending) return;

    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, onCancel]);

  if (!pending) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-modal-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-surface-card shadow-xl sm:rounded-2xl">
        {/* Cabeçalho */}
        <div className="border-b border-border-subtle px-5 py-4">
          <h2 id="action-modal-title" className="text-base font-semibold text-text-primary">
            {pending.actionLabel}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {pending.opportunity.contactName}
            {pending.opportunity.company ? ` · ${pending.opportunity.company}` : ""}
          </p>
        </div>

        {/* Corpo */}
        <div className="flowi-scroll flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Notice tone="pending" title="Confirmação necessária">
            {pending.reason}
          </Notice>

          <p className="text-sm text-text-secondary">{pending.preview.description}</p>

          {pending.preview.warnings.length > 0 ? (
            <Notice tone="warning" title="Atenção">
              <ul className="list-inside list-disc space-y-1">
                {pending.preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row">
            <DiffColumn title="Antes" data={pending.preview.before} tone="before" />
            <DiffColumn title="Depois" data={pending.preview.after} tone="after" />
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface-muted px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Evidências que sustentam esta sugestão
            </p>
            {pending.opportunity.evidence.length === 0 ? (
              <p className="mt-1 text-xs text-text-muted">Nenhuma evidência textual.</p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {pending.opportunity.evidence.slice(0, 4).map((signal) => (
                  <li key={signal.code} className="text-xs text-text-secondary">
                    <span className="font-medium">{signal.label}</span> — “{signal.excerpt}”
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-text-muted">
              Confiança da IA: {pending.opportunity.confidence}% · Score:{" "}
              {pending.opportunity.score}/100
            </p>
          </div>
        </div>

        {/* Rodapé */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-5 py-4">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            ref={confirmRef}
            variant="primary"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Aplicando..." : "Confirmar"}
          </Button>
        </div>
      </div>
    </div>
  );
}
