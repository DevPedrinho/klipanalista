import { type NextRequest } from "next/server";
import { agentsAdapter } from "@/server/integration/adapters";
import { failValidation, handleError, ok } from "@/server/http/respond";
import { loadOverview } from "@/server/services/intelligence.service";
import {
  buildTenantContext,
  buildWidgetContext,
  resolvePeriod,
  widgetParamsSchema,
} from "@/server/security/tenant-context";

/**
 * GET /api/intelligence/widget
 *
 * Contexto do widget aberto a partir de um atendimento ou de um card.
 * Prioriza a analise do cliente/atendimento de onde foi aberto.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * A analise le N conversas, cada uma com sua propria chamada de mensagens.
 * O servico ja se autolimita por orcamento de tempo (FLW_TEMPO_MAXIMO_MS);
 * este teto e a rede de seguranca da plataforma, acima daquele.
 */
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = widgetParamsSchema.safeParse(raw);

    if (!parsed.success) return failValidation(parsed.error.issues);
    const widget = buildWidgetContext(parsed.data);

    const users = await agentsAdapter.list({ accountId: widget.accountId });
    const context = buildTenantContext({
      accountId: widget.accountId,
      userId: widget.userId,
      allUsers: users.data,
    });

    // Janela mais larga: o widget precisa achar o caso especifico, mesmo antigo.
    const overview = await loadOverview({
      context,
      filters: { period: resolvePeriod({ preset: "90d" }) },
    });

    /* --- Prioriza o caso de onde o widget foi aberto --------------------- */
    const focused =
      overview.opportunities.find((o) => widget.sessionId && o.sessionId === widget.sessionId) ??
      overview.opportunities.find((o) => widget.cardId && o.cardId === widget.cardId) ??
      overview.opportunities.find((o) => widget.contactId && o.contactId === widget.contactId);

    const related = overview.opportunities
      .filter((o) => o.id !== focused?.id)
      .slice(0, 5);

    /**
     * Quando nada e encontrado, dizemos o motivo em vez de devolver vazio:
     * pode ser que a conversa exista mas nao tenha atingido o corte de score.
     */
    const notFoundReason = focused
      ? undefined
      : widget.sessionId || widget.contactId || widget.cardId
        ? "Este atendimento nao atingiu o corte minimo de score (30 pontos) ou nao " +
          "apresenta sinais comerciais suficientes para ser tratado como oportunidade."
        : "Nenhum identificador de contexto foi informado na URL do widget.";

    return ok(
      {
        widget,
        focused: focused ?? null,
        notFoundReason,
        related,
        kpis: overview.kpis,
        settings: overview.settings,
        role: context.role,
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
