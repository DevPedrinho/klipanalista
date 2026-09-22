import "server-only";
import { getEnv } from "@/server/config/env";
import { comReserva, ehProvedor, type Analista, type NomeDoProvedor } from "./provedor";
import { criarAnalistaAnthropic } from "./provedores/anthropic";
import { criarAnalistaOpenAi } from "./provedores/openai";

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
 * Modelo usado na analise, por provedor.
 *
 * Ler uma conversa comercial e decidir se ha oportunidade e julgamento, nao
 * classificacao mecanica: depende de entender quem disse o que, se o "vou
 * pensar" e educado ou real, se o orcamento foi aprovado de fato ou so
 * mencionado. E o tipo de tarefa que paga um modelo forte.
 *
 * Sobrescritivel em AI_MODEL para quem preferir outro ponto de custo — e a
 * alavanca de custo mais direta que existe aqui.
 */
export const MODELO_PADRAO: Record<NomeDoProvedor, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.1",
};

/**
 * Qual provedor atende primeiro.
 *
 * O outro, quando tem credencial, vira reserva automatica. Nao e refinamento:
 * quando o credito da Anthropic acabou, a leitura por IA parou inteira e o
 * painel passou dias so com a deteccao deterministica.
 */
export function getProvedor(): NomeDoProvedor {
  const bruto = process.env["AI_PROVIDER"]?.trim().toLowerCase() ?? "";
  return ehProvedor(bruto) ? bruto : "anthropic";
}

export function getModelo(provedor: NomeDoProvedor = getProvedor()): string {
  const escolhido = process.env["AI_MODEL"]?.trim();

  /*
   * `AI_MODEL` vale so para o provedor principal.
   *
   * Um nome de modelo nao atravessa fronteira: mandar `claude-opus-5` para a
   * OpenAI so produziria um erro a cada conversa. O reserva usa o padrao
   * dele, e quem quiser outro usa `AI_MODEL_RESERVA`.
   */
  if (provedor === getProvedor() && escolhido) return escolhido;

  if (provedor !== getProvedor()) {
    const doReserva = process.env["AI_MODEL_RESERVA"]?.trim();
    if (doReserva) return doReserva;
  }

  return MODELO_PADRAO[provedor];
}

/** Credencial de cada provedor. `AI_PROVIDER_API_KEY` segue sendo a Anthropic. */
function getChave(provedor: NomeDoProvedor): string | undefined {
  if (provedor === "anthropic") return getEnv().aiProviderApiKey;

  const bruta = process.env["OPENAI_API_KEY"]?.trim();
  return bruta && bruta.length > 0 ? bruta : undefined;
}

const analistas = new Map<NomeDoProvedor, Analista>();

function criar(provedor: NomeDoProvedor): Analista | null {
  const apiKey = getChave(provedor);
  if (!apiKey) return null;

  const existente = analistas.get(provedor);
  if (existente) return existente;

  const modelo = getModelo(provedor);
  const novo =
    provedor === "anthropic"
      ? criarAnalistaAnthropic({ apiKey, modelo })
      : criarAnalistaOpenAi({ apiKey, modelo });

  analistas.set(provedor, novo);
  return novo;
}

/**
 * O analista que atende, com reserva quando houver credencial dos dois.
 *
 * `null` quando nenhum provedor esta configurado — e o caso em que a analise
 * segue so com a deteccao deterministica, dizendo isso na tela.
 */
export function getAnalista(): Analista | null {
  const preferido = getProvedor();
  const outro: NomeDoProvedor = preferido === "anthropic" ? "openai" : "anthropic";

  const principal = criar(preferido) ?? criar(outro);
  if (!principal) return null;

  const reserva = principal.provedor === preferido ? criar(outro) : null;
  return comReserva(principal, reserva ?? undefined);
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
  return Boolean(getChave("anthropic") ?? getChave("openai"));
}

/** Apenas para testes: descarta os analistas memorizados. */
export function resetAiClient(): void {
  analistas.clear();
}
