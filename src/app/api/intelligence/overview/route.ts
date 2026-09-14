import { type NextRequest } from "next/server";
import { agentsAdapter } from "@/server/integration/adapters";
import { getIntegrationReadiness } from "@/server/config/env";
import { failValidation, handleError, ok } from "@/server/http/respond";
import { loadOverview } from "@/server/services/intelligence.service";
import {
  buildTenantContext,
  filtersSchema,
  resolvePeriod,
} from "@/server/security/tenant-context";

/**
 * GET /api/intelligence/overview
 *
 * Rota de leitura da Central de Inteligencia Comercial.
 * Executa somente no servidor: o token da API nunca chega ao browser.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = filtersSchema.safeParse(raw);

    if (!parsed.success) return failValidation(parsed.error.issues);
    const input = parsed.data;

    // O perfil e o escopo vem do cadastro da conta, nunca da URL.
    const users = await agentsAdapter.list({ accountId: input.accountId });
    const context = buildTenantContext({
      accountId: input.accountId,
      userId: input.userId,
      allUsers: users.data,
      requestedTeamId: input.teamId,
    });

    const period = resolvePeriod({
      preset: input.preset,
      from: input.from,
      to: input.to,
    });

    const overview = await loadOverview({
      context,
      filters: {
        period,
        teamId: input.teamId,
        agentId: input.agentId,
        priority: input.priority,
        search: input.search,
      },
    });

    const readiness = getIntegrationReadiness();

    return ok(
      {
        ...overview,
        period,
        context: {
          role: context.role,
          scope: context.visibleAgentIds === "ALL" ? "CONTA" : "EQUIPE_OU_PROPRIO",
        },
        integration: {
          ready: readiness.ready,
          missing: readiness.missing,
        },
        availableUsers: users.data.map((u) => ({
          id: u.id,
          name: u.name,
          teamId: u.teamId,
          teamName: u.teamName,
        })),
      },
      {
        dataMode: overview.dataMode,
        generatedAt: overview.lastAnalysisAt,
        pendingValidation: overview.pendingValidation,
      },
    );
  } catch (error) {
    return handleError(error);
  }
}
