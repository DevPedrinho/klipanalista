import { type NextRequest } from "next/server";
import { z } from "zod";
import { ACTION_STATUSES, ACTION_TYPES } from "@/domain/enums";
import { agentsAdapter } from "@/server/integration/adapters";
import { failValidation, handleError, ok } from "@/server/http/respond";
import { queryAudit, suggestionAcceptanceRate } from "@/server/services/audit.service";
import { buildTenantContext } from "@/server/security/tenant-context";

/**
 * GET /api/intelligence/audit
 *
 * Historico auditavel de tudo que a IA sugeriu ou executou.
 * Vendedores veem apenas os proprios registros; gestores e admins veem a conta.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  actionType: z.enum(ACTION_TYPES).optional(),
  actionStatus: z.enum(ACTION_STATUSES).optional(),
  targetId: z.string().max(200).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest) {
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = querySchema.safeParse(raw);

    if (!parsed.success) return failValidation(parsed.error.issues);
    const input = parsed.data;

    const users = await agentsAdapter.list({ accountId: input.accountId });
    const context = buildTenantContext({
      accountId: input.accountId,
      userId: input.userId,
      allUsers: users.data,
    });

    // Vendedor so enxerga o proprio historico.
    const requestedByUserId = context.role === "VENDEDOR" ? context.userId : undefined;

    const page = queryAudit({
      accountId: context.accountId,
      actionType: input.actionType,
      actionStatus: input.actionStatus,
      requestedByUserId,
      targetId: input.targetId,
      from: input.from,
      to: input.to,
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    });

    return ok(
      {
        ...page,
        acceptanceRate: suggestionAcceptanceRate(context.accountId),
        scope: context.role === "VENDEDOR" ? "PROPRIO" : "CONTA",
      },
      { dataMode: "mock" },
    );
  } catch (error) {
    return handleError(error);
  }
}
