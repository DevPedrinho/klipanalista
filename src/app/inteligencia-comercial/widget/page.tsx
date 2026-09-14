import { MissingParams } from "@/components/intelligence/MissingParams";
import { WidgetView } from "@/components/intelligence/WidgetView";

/**
 * Widget contextual.
 *
 * Aberto em popup por uma ação personalizada dentro do atendimento ou do CRM.
 * Recebe accountId, userId, contactId, sessionId, cardId e origem.
 */

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Ignora identificadores em formato inesperado em vez de propagá-los. */
function sanitize(value: string | undefined): string | undefined {
  return value && ID_PATTERN.test(value) ? value : undefined;
}

export default async function WidgetPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const accountId = sanitize(
    readParam(params, "accountId") ?? readParam(params, "tenantId"),
  );
  const userId = sanitize(readParam(params, "userId"));

  const missing: string[] = [];
  if (!accountId) missing.push("accountId (ou tenantId)");
  if (!userId) missing.push("userId");

  if (!accountId || !userId) {
    return <MissingParams missing={missing} context="widget" />;
  }

  const rawOrigin = readParam(params, "origin");
  const origin = rawOrigin === "crm" ? "crm" : "atendimento";

  return (
    <WidgetView
      accountId={accountId}
      userId={userId}
      contactId={sanitize(readParam(params, "contactId"))}
      sessionId={sanitize(readParam(params, "sessionId"))}
      cardId={sanitize(readParam(params, "cardId"))}
      origin={origin}
    />
  );
}
