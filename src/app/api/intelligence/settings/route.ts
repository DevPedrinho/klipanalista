import { type NextRequest } from "next/server";
import { z } from "zod";
import { ACTION_TYPES, AUTOMATION_MODES } from "@/domain/enums";
import { agentsAdapter } from "@/server/integration/adapters";
import { listPendingEndpoints } from "@/server/integration/endpoints";
import { getIntegrationReadiness } from "@/server/config/env";
import { fail, failValidation, handleError, ok } from "@/server/http/respond";
import { recordAudit } from "@/server/services/audit.service";
import {
  ACTION_LABELS,
  ALWAYS_CONFIRM,
  LOW_RISK_ACTIONS,
  MODE_LABELS,
} from "@/server/services/automation.service";
import { getSettings, updateSettings } from "@/server/services/settings.service";
import { TAG_TAXONOMY } from "@/server/services/tag-taxonomy.service";
import { buildTenantContext, canEditSettings } from "@/server/security/tenant-context";

/**
 * GET  /api/intelligence/settings — le a configuracao da conta
 * PUT  /api/intelligence/settings — atualiza (somente ADMIN)
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const readSchema = z.object({
  accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

const writeSchema = readSchema.extend({
  automationMode: z.enum(AUTOMATION_MODES).optional(),
  allowedAutoActions: z.array(z.enum(ACTION_TYPES)).optional(),
  dataRetentionDays: z.number().int().min(30).max(1095).optional(),
  allowTrainingUsage: z.boolean().optional(),
  defaultPanelId: z.string().max(128).optional(),
  triageStepId: z.string().max(128).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = readSchema.safeParse(raw);

    if (!parsed.success) return failValidation(parsed.error.issues);

    const users = await agentsAdapter.list({ accountId: parsed.data.accountId });
    const context = buildTenantContext({
      accountId: parsed.data.accountId,
      userId: parsed.data.userId,
      allUsers: users.data,
    });

    const readiness = getIntegrationReadiness();

    return ok(
      {
        settings: getSettings(context.accountId),
        canEdit: canEditSettings(context.role),
        role: context.role,
        catalog: {
          modes: MODE_LABELS,
          lowRiskActions: LOW_RISK_ACTIONS.map((a) => ({ type: a, label: ACTION_LABELS[a] })),
          alwaysConfirm: ALWAYS_CONFIRM.map((a) => ({ type: a, label: ACTION_LABELS[a] })),
          tagTaxonomy: TAG_TAXONOMY,
        },
        integration: {
          ready: readiness.ready,
          missing: readiness.missing,
          dataMode: readiness.dataMode,
          // Transparencia: a tela mostra exatamente o que falta confirmar.
          pendingEndpoints: listPendingEndpoints().map((e) => ({
            key: e.key,
            method: e.method,
            path: e.path,
            group: e.group,
            summary: e.summary,
            pending: e.pending,
          })),
        },
      },
      { dataMode: readiness.dataMode },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = writeSchema.safeParse(json);

    if (!parsed.success) return failValidation(parsed.error.issues);
    const input = parsed.data;

    const users = await agentsAdapter.list({ accountId: input.accountId });
    const context = buildTenantContext({
      accountId: input.accountId,
      userId: input.userId,
      allUsers: users.data,
    });

    if (!canEditSettings(context.role)) {
      return fail(
        "SEM_PERMISSAO",
        "Apenas administradores podem alterar as configuracoes de automacao.",
      );
    }

    const requester = users.data.find((u) => u.id === context.userId);
    const before = getSettings(context.accountId);

    const after = updateSettings({
      accountId: context.accountId,
      updatedByUserId: context.userId,
      automationMode: input.automationMode,
      allowedAutoActions: input.allowedAutoActions,
      dataRetentionDays: input.dataRetentionDays,
      allowTrainingUsage: input.allowTrainingUsage,
      defaultPanelId: input.defaultPanelId,
      triageStepId: input.triageStepId,
    });

    recordAudit({
      accountId: context.accountId,
      requestedByUserId: context.userId,
      requestedByName: requester?.name ?? context.userId,
      actionType: "MARCAR_ANALISADA",
      actionStatus: "EXECUTADA",
      targetKind: "CONTATO",
      targetId: context.accountId,
      targetLabel: "Configuracoes de automacao",
      suggestion: "Alteracao das configuracoes do Flowi Copilot Comercial",
      evidenceCodes: [],
      before: { ...before } as unknown as Record<string, unknown>,
      after: { ...after } as unknown as Record<string, unknown>,
      aiConfidence: 100,
      automationMode: after.automationMode,
      success: true,
      approvedByUserId: context.userId,
      approvedByName: requester?.name,
    });

    return ok({ settings: after }, { dataMode: "mock" });
  } catch (error) {
    return handleError(error);
  }
}
