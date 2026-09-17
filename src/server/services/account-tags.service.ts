import "server-only";
import type { MessageSnapshot, SuggestedAccountTag, Tag } from "@/domain/types";

export type { SuggestedAccountTag };

/**
 * Sugestao de etiquetas A PARTIR DAS ETIQUETAS DA PROPRIA CONTA.
 *
 * POR QUE ISTO EXISTE
 *
 * A primeira versao trazia uma taxonomia propria — "IA | Oportunidade
 * quente", "IA | Urgencia" — e tentava casa-la com o que a conta ja tinha.
 * Medido contra a conta real: ZERO das 11 chaves encontrou equivalente. As
 * 18 etiquetas de la sao outras, e sao melhores: `4k-7k` e faixa de
 * orcamento, `PC Gamer` e `PC Trabalho` sao interesse de produto, `B2B` e
 * `B2C` sao porte, `Meta ADS` e `Indicacao` sao origem. Elas descrevem o
 * negocio do cliente; a taxonomia descrevia o modelo.
 *
 * Como a regra do produto e nunca criar etiqueta sem aprovacao, o resultado
 * pratico era uma acao que respondia "precisa de aprovacao" em toda
 * tentativa — correta, e indistinguivel de quebrada para quem olha a tela.
 *
 * Entao a direcao se inverte: em vez de a conta se adaptar ao vocabulario da
 * IA, a IA passa a sugerir o vocabulario da conta.
 *
 * AS DUAS REGRAS SAO DETERMINISTICAS E GERAIS
 *
 * Nenhuma delas conhece "PC Gamer" ou "4k-7k". Ambas funcionam em qualquer
 * conta, com qualquer vocabulario:
 *
 *   FAIXA   — etiquetas cujo NOME e um intervalo numerico ("2k-4k",
 *             "1000-5000", "R$ 8k a 15k") viram faixa de valor. Quando a
 *             oportunidade tem valor estimado, a faixa que o contem e
 *             sugerida.
 *
 *   MENCAO  — quando o nome da etiqueta aparece LITERALMENTE na conversa,
 *             ela e sugerida com o trecho que a menciona. E a mesma regra
 *             que sustenta o resto do modulo: a evidencia e texto real, nao
 *             interpretacao.
 *
 * O que exige julgamento — se o cliente e B2B, se merece "Vip", se e caso de
 * "Atencao" — fica para a IA, que escolhe da mesma lista real e tambem
 * precisa ancorar a escolha num trecho.
 */

/* ==========================================================================
   Faixas de valor
   ========================================================================== */

export interface FaixaDeValor {
  tag: Tag;
  minimo: number;
  maximo: number;
}

/**
 * Le um numero escrito como as pessoas escrevem em etiqueta: `4k`, `4K`,
 * `4.000`, `4000`. Devolve `null` quando nao e numero.
 */
function lerNumero(bruto: string): number | null {
  const limpo = bruto.trim().toLowerCase().replace(/\./g, "").replace(/,/g, ".");

  const comK = /^(\d+(?:\.\d+)?)k$/.exec(limpo);
  if (comK?.[1]) return Math.round(Number(comK[1]) * 1000);

  const simples = /^(\d+(?:\.\d+)?)$/.exec(limpo);
  if (simples?.[1]) return Number(simples[1]);

  return null;
}

/**
 * Reconhece etiquetas cujo nome e um intervalo de valores.
 *
 * Aceita separador `-`, `a` ou `ate`, com ou sem prefixo de moeda, porque
 * cada conta escreve do seu jeito. Uma etiqueta que nao siga nenhum desses
 * formatos simplesmente nao vira faixa — o silencio e melhor que um palpite.
 */
export function lerFaixasDeValor(tags: Tag[]): FaixaDeValor[] {
  const faixas: FaixaDeValor[] = [];

  for (const tag of tags) {
    const semMoeda = tag.name.replace(/r\$/gi, " ").trim();
    /*
     * O separador por extenso exige espaco dos dois lados, e `ate` vem antes
     * de `a` na alternancia.
     *
     * Sem isso, "500 ate 900" casava com o `a` de "ate" e devolvia "te 900"
     * como limite superior — a etiqueta era descartada em silencio. E, sem
     * exigir os espacos, "Beach Park" virava intervalo de "Be" ate "ch Park".
     */
    const partes = /^(.+?)(?:\s*-\s*|\s+(?:ate|até|a)\s+)(.+?)$/i.exec(semMoeda);
    if (!partes) continue;

    const minimo = lerNumero(partes[1] ?? "");
    const maximo = lerNumero(partes[2] ?? "");

    if (minimo === null || maximo === null) continue;
    if (maximo <= minimo) continue;

    faixas.push({ tag, minimo, maximo });
  }

  return faixas.sort((a, b) => a.minimo - b.minimo);
}

/* ==========================================================================
   Mencao literal
   ========================================================================== */

/** Normaliza para comparar: minusculas, sem acento, sem pontuacao. */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Nomes curtos demais nao servem como mencao.
 *
 * Uma etiqueta chamada "PC" acertaria qualquer conversa que dissesse "pc", e
 * uma chamada "B2B" casaria com ruido. Tres caracteres e o piso, e nomes de
 * uma letra ou dois digitos ficam de fora — quem decide esses casos e a IA,
 * com contexto.
 */
const MINIMO_PARA_MENCAO = 4;

function mencionada(nomeNormalizado: string, mensagemNormalizada: string): boolean {
  // Compara com bordas de palavra, para "vip" nao casar dentro de "vipers".
  const padrao = new RegExp(`(^| )${nomeNormalizado.replace(/ /g, " ")}( |$)`);
  return padrao.test(mensagemNormalizada);
}

/* ==========================================================================
   Sugestao
   ========================================================================== */

/** Recorta a evidencia em volta da mencao, sem passar do limite da tela. */
function recortar(texto: string, posicao: number, tamanho: number): string {
  const LIMITE = 200;
  if (texto.length <= LIMITE) return texto.trim();

  const folga = Math.floor((LIMITE - tamanho) / 2);
  const de = Math.max(0, posicao - folga);
  const ate = Math.min(texto.length, posicao + tamanho + folga);

  return (
    (de > 0 ? "..." : "") + texto.slice(de, ate).trim() + (ate < texto.length ? "..." : "")
  );
}

export function sugerirEtiquetasDaConta(params: {
  tags: Tag[];
  messages: MessageSnapshot[];
  estimatedValue?: number;
}): SuggestedAccountTag[] {
  const sugestoes: SuggestedAccountTag[] = [];
  const jaSugeridas = new Set<string>();

  /* --- 1. Faixa de valor ------------------------------------------------- */
  const faixas = lerFaixasDeValor(params.tags);
  const valor = params.estimatedValue;

  if (typeof valor === "number" && valor > 0) {
    const faixa = faixas.find((f) => valor >= f.minimo && valor <= f.maximo);
    if (faixa) {
      jaSugeridas.add(faixa.tag.id);
      sugestoes.push({
        tagId: faixa.tag.id,
        tagName: faixa.tag.name,
        motivo: `Valor estimado da oportunidade cai nesta faixa.`,
        origem: "FAIXA_DE_VALOR",
      });
    }
  }

  /* --- 2. Mencao literal na conversa ------------------------------------- */
  // As etiquetas de faixa ficam de fora: "4k-7k" dito na conversa e coincidencia
  // de numero, nao mencao de etiqueta.
  const idsDeFaixa = new Set(faixas.map((f) => f.tag.id));

  for (const tag of params.tags) {
    if (jaSugeridas.has(tag.id) || idsDeFaixa.has(tag.id)) continue;

    const nome = normalizar(tag.name);
    if (nome.length < MINIMO_PARA_MENCAO) continue;

    for (const mensagem of params.messages) {
      const texto = mensagem.text ?? "";
      if (!texto) continue;

      if (!mencionada(nome, normalizar(texto))) continue;

      // Acha a posicao aproximada no texto ORIGINAL, para citar de verdade.
      const posicao = texto.toLowerCase().indexOf(tag.name.toLowerCase());

      jaSugeridas.add(tag.id);
      sugestoes.push({
        tagId: tag.id,
        tagName: tag.name,
        motivo: "O cliente mencionou isto na conversa.",
        trecho:
          posicao >= 0 ? recortar(texto, posicao, tag.name.length) : recortar(texto, 0, 0),
        origem: "MENCAO_NA_CONVERSA",
      });
      break;
    }
  }

  return sugestoes;
}
