import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/server/config/env";

/**
 * Cliente da IA.
 *
 * O modulo funciona sem IA: a deteccao deterministica continua sendo o piso.
 * Quando `AI_PROVIDER_API_KEY` existe, a leitura das conversas ganha um
 * analista que entende contexto, ironia e pedido implicito — coisas que
 * expressao regular nao alcanca.
 *
 * Importa `server-only`: a credencial nunca chega ao browser.
 */

/**
 * Modelo usado na analise.
 *
 * Ler uma conversa comercial e decidir se ha oportunidade e julgamento, nao
 * classificacao mecanica: depende de entender quem disse o que, se o "vou
 * pensar" e educado ou real, se o orcamento foi aprovado de fato ou so
 * mencionado. E o tipo de tarefa que paga um modelo forte.
 *
 * Sobrescritivel em AI_MODEL para quem preferir outro ponto de custo.
 */
export const MODELO_PADRAO = "claude-opus-5";

let cliente: Anthropic | null = null;

export function getAiClient(): Anthropic | null {
  const { aiProviderApiKey } = getEnv();
  if (!aiProviderApiKey) return null;

  cliente ??= new Anthropic({ apiKey: aiProviderApiKey });
  return cliente;
}

export function getModelo(): string {
  return process.env["AI_MODEL"]?.trim() || MODELO_PADRAO;
}

/** Diz se a analise por IA esta disponivel nesta instalacao. */
export function aiHabilitada(): boolean {
  return Boolean(getEnv().aiProviderApiKey);
}

/** Apenas para testes: descarta o cliente memorizado. */
export function resetAiClient(): void {
  cliente = null;
}
