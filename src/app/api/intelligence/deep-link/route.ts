import { type NextRequest } from "next/server";
import { z } from "zod";
import { agentsAdapter, authAdapter } from "@/server/integration/adapters";
import { fail, failValidation, handleError, ok } from "@/server/http/respond";
import { loadOverview } from "@/server/services/intelligence.service";
import { buildTenantContext, resolvePeriod } from "@/server/security/tenant-context";

/**
 * POST /api/intelligence/deep-link
 *
 * Gera o link para abrir um atendimento na KlipFlowi.
 *
 * A GERACAO DO LOGIN INTEGRADO ACONTECE EXCLUSIVAMENTE AQUI, NO SERVIDOR.
 * O frontend nunca monta esse link nem recebe qualquer token.
 *
 * O atendimento solicitado e validado contra o escopo do usuario: trocar o
 * sessionId na requisicao nao da acesso a uma conversa que ele nao poderia ver.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) return failValidation(parsed.error.issues);
    const input = parsed.data;

    const users = await agentsAdapter.list({ accountId: input.accountId });
    const context = buildTenantContext({
      accountId: input.accountId,
      userId: input.userId,
      allUsers: users.data,
    });

    // Confirma que o atendimento pedido esta no escopo visivel do usuario.
    const overview = await loadOverview({
      context,
      filters: { period: resolvePeriod({ preset: "90d" }) },
    });

    const allowed = overview.opportunities.some((o) => o.sessionId === input.sessionId);
    if (!allowed) {
      return fail(
        "SEM_PERMISSAO",
        "Voce nao tem acesso a este atendimento ou ele nao esta no periodo analisado.",
      );
    }

    const link = await authAdapter.buildSessionDeepLink({
      accountId: context.accountId,
      userId: context.userId,
      sessionId: input.sessionId,
    });

    return ok(link, {
      dataMode: overview.dataMode,
      pendingValidation: link.pendingValidation,
    });
  } catch (error) {
    return handleError(error);
  }
}
