import { MissingParams } from "@/components/intelligence/MissingParams";
import { SettingsView } from "@/components/intelligence/SettingsView";

/** Configurações dos modos de automação e diagnóstico da integração. */

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

export default async function SettingsPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const accountId = readParam(params, "accountId") ?? readParam(params, "tenantId");
  const userId = readParam(params, "userId");

  const missing: string[] = [];
  if (!accountId) missing.push("accountId (ou tenantId)");
  if (!userId) missing.push("userId");

  if (!accountId || !userId || !ID_PATTERN.test(accountId) || !ID_PATTERN.test(userId)) {
    return <MissingParams missing={missing.length > 0 ? missing : ["formato inválido"]} context="central" />;
  }

  return <SettingsView accountId={accountId} userId={userId} />;
}
