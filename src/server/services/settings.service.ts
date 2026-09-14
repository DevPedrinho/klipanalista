import "server-only";
import type { AutomationMode } from "@/domain/enums";
import type { IntegrationSettings } from "@/domain/types";
import { ALWAYS_CONFIRM, LOW_RISK_ACTIONS, defaultSettings } from "./automation.service";

/**
 * Configuracoes de integracao por conta.
 *
 * Armazenamento em memoria nesta entrega; espelha a tabela
 * `integration_settings` de db/migrations/0001_init.sql.
 */

const store = new Map<string, IntegrationSettings>();

export function getSettings(accountId: string): IntegrationSettings {
  const existing = store.get(accountId);
  if (existing) return existing;

  const created = defaultSettings(accountId);
  store.set(accountId, created);
  return created;
}

export interface UpdateSettingsInput {
  accountId: string;
  updatedByUserId: string;
  automationMode?: AutomationMode;
  allowedAutoActions?: string[];
  dataRetentionDays?: number;
  allowTrainingUsage?: boolean;
  defaultPanelId?: string;
  triageStepId?: string;
}

export function updateSettings(input: UpdateSettingsInput): IntegrationSettings {
  const current = getSettings(input.accountId);

  // Somente acoes reconhecidas como de baixo risco podem ser automatizadas.
  // Nenhuma configuracao consegue liberar o que esta em ALWAYS_CONFIRM.
  const requestedAuto = input.allowedAutoActions;
  const allowedAutoActions = requestedAuto
    ? LOW_RISK_ACTIONS.filter(
        (action) => requestedAuto.includes(action) && !ALWAYS_CONFIRM.includes(action),
      )
    : current.guardrails.allowedAutoActions;

  const updated: IntegrationSettings = {
    ...current,
    automationMode: input.automationMode ?? current.automationMode,
    guardrails: {
      allowedAutoActions: [...allowedAutoActions],
      alwaysRequireConfirmation: [...ALWAYS_CONFIRM],
    },
    dataRetentionDays: clampRetention(input.dataRetentionDays ?? current.dataRetentionDays),
    allowTrainingUsage: input.allowTrainingUsage ?? current.allowTrainingUsage,
    defaultPanelId: input.defaultPanelId ?? current.defaultPanelId,
    triageStepId: input.triageStepId ?? current.triageStepId,
    updatedAt: new Date().toISOString(),
    updatedByUserId: input.updatedByUserId,
  };

  store.set(input.accountId, updated);
  return updated;
}

/** Retencao entre 30 e 1095 dias (3 anos). */
function clampRetention(days: number): number {
  return Math.min(1095, Math.max(30, Math.round(days)));
}

/** Apenas para testes. */
export function clearSettings(): void {
  store.clear();
}
