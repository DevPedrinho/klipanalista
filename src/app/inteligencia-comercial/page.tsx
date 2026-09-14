import { IntelligenceCenter } from "@/components/intelligence/IntelligenceCenter";
import { MissingParams } from "@/components/intelligence/MissingParams";

/**
 * Central de Inteligência Comercial.
 *
 * Rota destinada a ser incorporada como página interna em um menu
 * personalizado da KlipFlowi. Os parâmetros chegam pela URL e são validados
 * aqui (formato) e no servidor (existência e permissão).
 */

export const dynamic = "force-dynamic";

interface PageProps {
  // No Next 16 os searchParams são assíncronos.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = params[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Mesmo formato aceito pelo servidor: evita ida e volta desnecessária. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;

  // Aceita tenantId como alternativa a accountId, conforme o briefing.
  const accountId = readParam(params, "accountId") ?? readParam(params, "tenantId");
  const userId = readParam(params, "userId");

  const missing: string[] = [];
  if (!accountId) missing.push("accountId (ou tenantId)");
  if (!userId) missing.push("userId");

  if (!accountId || !userId) {
    return <MissingParams missing={missing} context="central" />;
  }

  if (!ID_PATTERN.test(accountId) || !ID_PATTERN.test(userId)) {
    return (
      <MissingParams
        missing={["accountId e userId devem conter apenas letras, números, hífen e underscore"]}
        context="central"
      />
    );
  }

  return <IntelligenceCenter accountId={accountId} userId={userId} />;
}
