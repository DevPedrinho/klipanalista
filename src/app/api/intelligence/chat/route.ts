import { type NextRequest } from "next/server";
import { z } from "zod";
import { agentsAdapter } from "@/server/integration/adapters";
import { failValidation, handleError, ok } from "@/server/http/respond";
import { answerQuestion, SUGGESTED_QUESTIONS } from "@/server/services/chat.service";
import { loadOverview } from "@/server/services/intelligence.service";
import {
  buildTenantContext,
  resolvePeriod,
} from "@/server/security/tenant-context";

/**
 * POST /api/intelligence/chat
 *
 * Responde perguntas usando SOMENTE os dados visiveis para aquele usuario
 * e conta. O contexto e montado no servidor a cada pergunta: o cliente nao
 * pode injetar dados de outra conta no prompt.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  question: z.string().min(1, "A pergunta nao pode ficar vazia.").max(1000),
  preset: z.enum(["7d", "15d", "30d", "90d"]).optional(),
  teamId: z.string().max(128).optional(),
  agentId: z.string().max(128).optional(),
  /** Oportunidade em foco quando a pergunta vem do widget. */
  focusedOpportunityId: z.string().max(200).optional(),
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
      requestedTeamId: input.teamId,
    });

    const period = resolvePeriod({ preset: input.preset });
    const overview = await loadOverview({
      context,
      filters: { period, teamId: input.teamId, agentId: input.agentId },
    });

    const answer = answerQuestion(input.question, {
      tenant: context,
      opportunities: overview.opportunities,
      funnels: overview.funnels,
      qualityReports: overview.qualityReports,
      focusedOpportunityId: input.focusedOpportunityId,
    });

    return ok(
      { message: answer, suggestions: SUGGESTED_QUESTIONS },
      {
        dataMode: overview.dataMode,
        pendingValidation: overview.pendingValidation,
      },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET() {
  return ok(
    { suggestions: SUGGESTED_QUESTIONS },
    { dataMode: "mock" },
  );
}
