import { getIntegrationReadiness } from "@/server/config/env";
import { listAllEndpoints, listPendingEndpoints } from "@/server/integration/endpoints";
import { ok } from "@/server/http/respond";

/**
 * GET /api/health
 *
 * Diagnostico da integracao. Nao expoe token nem URL base: apenas diz o que
 * esta configurado e quais contratos continuam pendentes de validacao.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const readiness = getIntegrationReadiness();
  const all = listAllEndpoints();
  const pending = listPendingEndpoints();

  return ok(
    {
      status: "ok",
      dataMode: readiness.dataMode,
      integrationReady: readiness.ready,
      missingEnvVars: readiness.missing,
      endpoints: {
        total: all.length,
        confirmed: all.length - pending.length,
        pending: pending.length,
        pendingList: pending.map((e) => ({
          key: e.key,
          method: e.method,
          path: e.path || "(desconhecido)",
          group: e.group,
          pending: e.pending,
        })),
      },
    },
    { dataMode: readiness.dataMode },
  );
}
