import "server-only";

/**
 * Leitura centralizada das variaveis de ambiente.
 *
 * Este arquivo importa `server-only`: qualquer tentativa de importa-lo a
 * partir de um componente de cliente quebra o build. E a barreira que
 * garante que FLW_API_TOKEN nunca seja empacotado no bundle do browser.
 */

export type DataMode = "mock" | "live";

function readString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface AppEnv {
  apiToken?: string;
  coreApiUrl?: string;
  chatApiUrl?: string;
  authApiUrl?: string;
  aiProviderApiKey?: string;
  appBaseUrl: string;
  webhookSecret?: string;
  webhookSignatureHeader: string;
  dataMode: DataMode;
  embedOrigins: string[];
}

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cached) return cached;

  const rawMode = readString("FLW_DATA_MODE")?.toLowerCase();
  const dataMode: DataMode = rawMode === "live" ? "live" : "mock";

  const coreApiUrl = readString("FLW_CORE_API_URL");
  const chatApiUrl = readString("FLW_CHAT_API_URL");
  const authApiUrl = readString("FLW_AUTH_API_URL");

  cached = {
    apiToken: readString("FLW_API_TOKEN"),
    coreApiUrl: coreApiUrl ? stripTrailingSlash(coreApiUrl) : undefined,
    chatApiUrl: chatApiUrl ? stripTrailingSlash(chatApiUrl) : undefined,
    authApiUrl: authApiUrl ? stripTrailingSlash(authApiUrl) : undefined,
    aiProviderApiKey: readString("AI_PROVIDER_API_KEY"),
    appBaseUrl: stripTrailingSlash(readString("APP_BASE_URL") ?? "http://localhost:3000"),
    webhookSecret: readString("FLW_WEBHOOK_SECRET"),
    webhookSignatureHeader:
      readString("FLW_WEBHOOK_SIGNATURE_HEADER") ?? "x-klipflowi-signature",
    dataMode,
    embedOrigins: (readString("FLW_EMBED_ORIGINS") ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };

  return cached;
}

/** Apenas para testes: descarta o cache de ambiente. */
export function resetEnvCache(): void {
  cached = null;
}

export interface IntegrationReadiness {
  ready: boolean;
  /** Lista legivel do que falta configurar. */
  missing: string[];
  dataMode: DataMode;
}

/**
 * Diz se a integracao real pode ser usada. A UI consome isso para exibir o
 * estado "sem integracao" em vez de falhar silenciosamente.
 */
export function getIntegrationReadiness(): IntegrationReadiness {
  const env = getEnv();
  const missing: string[] = [];

  if (!env.apiToken) missing.push("FLW_API_TOKEN");
  if (!env.coreApiUrl) missing.push("FLW_CORE_API_URL");
  if (!env.chatApiUrl) missing.push("FLW_CHAT_API_URL");

  return {
    ready: env.dataMode === "live" && missing.length === 0,
    missing,
    dataMode: env.dataMode,
  };
}
