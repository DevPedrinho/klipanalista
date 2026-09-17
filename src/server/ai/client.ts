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

/**
 * Esforco de raciocinio por conversa.
 *
 * Medido contra a conta real: com esforco alto (o padrao da API), UMA leva de
 * 4 conversas consumiu os 22 segundos de orcamento inteiros — 4 conversas
 * lidas de 57. As outras 53 ficaram so com a deteccao deterministica.
 *
 * Nao e um bom negocio. Ler uma conversa de WhatsApp e apontar qual frase
 * sustenta cada sinal e uma tarefa de leitura, nao de raciocinio profundo: o
 * texto esta todo ali, e a regra mais dura do modulo — o trecho tem que
 * existir — nao fica mais bem cumprida por pensar mais.
 *
 * `low` troca profundidade por alcance, e alcance e o que faltava. A
 * alternativa honesta nao era "57 conversas bem lidas contra 57 lidas por
 * cima": era 57 contra 4.
 *
 * Sobrescritivel em AI_EFFORT para quem quiser o outro lado da troca.
 */
export type EsforcoDaIa = "low" | "medium" | "high" | "xhigh" | "max";

export function getEsforco(): EsforcoDaIa {
  const bruto = process.env["AI_EFFORT"]?.trim().toLowerCase();
  const validos: EsforcoDaIa[] = ["low", "medium", "high", "xhigh", "max"];
  return validos.find((e) => e === bruto) ?? "low";
}

/**
 * Conversas analisadas em paralelo.
 *
 * Com 4 por vez, 57 conversas exigiriam 15 levas sequenciais — muito alem do
 * orcamento. As chamadas sao independentes entre si, entao o paralelismo e o
 * que converte o orcamento de tempo em cobertura.
 */
export function getConcorrencia(): number {
  const bruto = Number(process.env["AI_CONCORRENCIA"]);
  return Number.isFinite(bruto) && bruto > 0 ? Math.min(40, Math.floor(bruto)) : 20;
}

/** Diz se a analise por IA esta disponivel nesta instalacao. */
export function aiHabilitada(): boolean {
  return Boolean(getEnv().aiProviderApiKey);
}

/** Apenas para testes: descarta o cliente memorizado. */
export function resetAiClient(): void {
  cliente = null;
}
