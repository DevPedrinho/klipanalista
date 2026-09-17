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
  crmApiUrl?: string;
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

  const apiToken = readString("FLW_API_TOKEN");

  /**
   * Modo de dados.
   *
   * Deriva da presenca do token: configurar a credencial JA significa querer
   * dados reais. Exigir um segundo interruptor so produziria o caso confuso de
   * ter o token configurado e continuar vendo dados simulados sem saber por que.
   *
   * `FLW_DATA_MODE` continua valendo quando informado — util para desligar a
   * integracao temporariamente sem remover a credencial.
   */
  const rawMode = readString("FLW_DATA_MODE")?.toLowerCase();
  const dataMode: DataMode =
    rawMode === "live" ? "live" : rawMode === "mock" ? "mock" : apiToken ? "live" : "mock";

  /**
   * URLs base por grupo de servico.
   *
   * Nao sao segredo: sao endereco publico, confirmado na documentacao oficial
   * (https://api.wts.chat/core/v1/contact/{id}/tags e
   * https://api.wts.chat/crm/v3/panel/card/{id}). Ter um padrao aqui evita
   * obrigar quem instala a digitar tres valores que nunca mudam — e deixa
   * apenas a credencial como configuracao obrigatoria.
   *
   * Continuam sobrescritiveis por ambiente, para instancias dedicadas.
   */
  const coreApiUrl = readString("FLW_CORE_API_URL") ?? "https://api.wts.chat/core";
  const chatApiUrl = readString("FLW_CHAT_API_URL") ?? "https://api.wts.chat/chat";
  const crmApiUrl = readString("FLW_CRM_API_URL") ?? "https://api.wts.chat/crm";
  const authApiUrl = readString("FLW_AUTH_API_URL");

  /**
   * URL publica do modulo.
   *
   * Ordem de resolucao:
   *  1. APP_BASE_URL, quando definida explicitamente;
   *  2. o dominio de producao da Vercel, quando houver;
   *  3. a URL do deploy atual da Vercel (preview);
   *  4. localhost, para desenvolvimento.
   *
   * Sem isso, um deploy sem APP_BASE_URL configurada anunciaria o endereco
   * do webhook como "http://localhost:3000", que nao serve para nada.
   */
  const vercelProductionUrl = readString("VERCEL_PROJECT_PRODUCTION_URL");
  const vercelDeploymentUrl = readString("VERCEL_URL");

  const appBaseUrl =
    readString("APP_BASE_URL") ??
    (vercelProductionUrl ? `https://${vercelProductionUrl}` : undefined) ??
    (vercelDeploymentUrl ? `https://${vercelDeploymentUrl}` : undefined) ??
    "http://localhost:3000";

  cached = {
    apiToken,
    coreApiUrl: stripTrailingSlash(coreApiUrl),
    chatApiUrl: stripTrailingSlash(chatApiUrl),
    crmApiUrl: stripTrailingSlash(crmApiUrl),
    authApiUrl: authApiUrl ? stripTrailingSlash(authApiUrl) : undefined,
    aiProviderApiKey: readString("AI_PROVIDER_API_KEY"),
    appBaseUrl: stripTrailingSlash(appBaseUrl),
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

  // As URLs base tem padrao oficial, entao a credencial e a unica coisa que
  // precisa ser informada por quem instala.
  if (!env.apiToken) missing.push("FLW_API_TOKEN");

  return {
    ready: env.dataMode === "live" && missing.length === 0,
    missing,
    dataMode: env.dataMode,
  };
}
