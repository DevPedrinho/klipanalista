import "server-only";
// O helper `zodOutputFormat` do SDK e escrito contra a API v4 do Zod. O
// pacote instalado (3.25) publica essa API no subcaminho `zod/v4`, entao este
// arquivo — e so ele — usa esse import. O resto do projeto segue no v3.
import * as z from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import Anthropic from "@anthropic-ai/sdk";
import type { ConversationSnapshot, DetectedSignal } from "@/domain/types";
import { SIGNAL_CATALOG } from "@/server/scoring/signals";
import { maskEmail, maskPhone } from "@/server/security/masking";
import { getAiClient, getEsforco, getModelo } from "./client";

/**
 * Analista de oportunidades.
 *
 * A IA LE a conversa; ela NAO pontua.
 *
 * Essa separacao e a decisao central deste arquivo. Deixar o modelo devolver
 * um score de 0 a 100 daria numeros mais "espertos" e completamente
 * inauditaveis: dois clientes parecidos receberiam notas diferentes sem que
 * ninguem soubesse explicar por que, e a nota mudaria sozinha a cada troca de
 * modelo. Entao o modelo faz o que sabe fazer melhor — entender o que foi
 * dito — e devolve SINAIS com o trecho literal que os sustenta. O motor
 * deterministico continua calculando score, confianca e prioridade a partir
 * desses sinais, com os mesmos pesos de sempre.
 *
 * Resultado: a leitura melhora, a explicacao continua de pe.
 *
 * ANTI-INVENCAO — a garantia dura deste modulo: todo sinal traz um trecho, e
 * todo trecho e conferido contra as mensagens reais antes de ser aceito. Um
 * sinal cujo trecho nao existe na conversa e DESCARTADO, por mais convincente
 * que soe. Nao e refinamento: e o que separa "a IA encontrou uma oportunidade"
 * de "a IA escreveu uma oportunidade".
 */

/* --------------------------------------------------------------------------
   Contrato de saida
   -------------------------------------------------------------------------- */

const SinalSchema = z.object({
  codigo: z
    .string()
    .describe("Codigo do catalogo de sinais. Use APENAS codigos listados."),
  trecho: z
    .string()
    .describe(
      "Trecho LITERAL e continuo da conversa que sustenta o sinal, copiado " +
        "exatamente como aparece. Nao parafraseie, nao junte partes distantes.",
    ),
  quemDisse: z
    .enum(["CLIENTE", "ATENDENTE"])
    .describe("Quem escreveu o trecho citado."),
  forca: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "0 a 1. Quao inequivocamente o trecho sustenta o sinal. Uma mencao de " +
        "passagem fica perto de 0,3; uma afirmacao explicita, perto de 1.",
    ),
});

/**
 * ICP — perfil de cliente ideal.
 *
 * Mede o CLIENTE, nao o negocio. E uma pergunta diferente da que o score de
 * oportunidade responde:
 *
 *   score de oportunidade -> quanto este negocio merece atencao AGORA
 *   ICP                   -> quanto este cliente se parece com quem compra
 *
 * Os dois se separam na pratica o tempo todo. Alguem com ICP alto e prazo
 * distante nao e urgente, mas vale cultivar. Alguem com ICP baixo pedindo
 * orcamento hoje e urgente e provavelmente nao fecha. Somar os dois num
 * numero so apagaria justamente a informacao que faz o vendedor escolher
 * onde gastar a proxima hora.
 *
 * Cada dimensao exige o trecho que a sustenta. `trecho: null` e uma resposta
 * legitima e significa "a conversa nao falou disso" — que e diferente de
 * "falou e foi ruim".
 */
const DimensaoIcpSchema = z.object({
  nota: z.number().min(0).describe("Pontos atribuidos, dentro do maximo da dimensao."),
  justificativa: z.string().describe("Uma frase dizendo por que esta nota."),
  trecho: z
    .string()
    .nullable()
    .describe(
      "Trecho LITERAL da conversa que sustenta a nota. null quando a conversa " +
        "nao trouxe nada sobre esta dimensao — o que e uma resposta valida.",
    ),
});

const IcpSchema = z.object({
  fitDeNecessidade: DimensaoIcpSchema.describe(
    "0 a 25. O que o cliente procura e o que esta empresa vende? Pedido " +
      "especifico e compativel pontua alto; duvida generica ou produto de " +
      "outro ramo pontua baixo.",
  ),
  poderDeDecisao: DimensaoIcpSchema.describe(
    "0 a 20. A pessoa decide a compra? Fala em nome proprio, ja comprou " +
      "antes, cita orcamento que controla — alto. Precisa consultar terceiro " +
      "ou e intermediario — baixo.",
  ),
  orcamento: DimensaoIcpSchema.describe(
    "0 a 20. Ha verba e ela cabe? Faixa declarada compativel pontua alto. " +
      "Restricao explicita ('nao tenho condicao agora') pontua baixo, mas " +
      "NAO zera se houver data para ter.",
  ),
  prazo: DimensaoIcpSchema.describe(
    "0 a 20. Quando pretende comprar? Data concreta pontua alto; 'algum dia' " +
      "pontua baixo.",
  ),
  engajamento: DimensaoIcpSchema.describe(
    "0 a 15. O cliente se envolve? Responde, manda dados (CNPJ, " +
      "especificacoes), faz perguntas — alto. Sumiu apos a primeira " +
      "mensagem — baixo.",
  ),
  perfilResumido: z
    .string()
    .describe("Quem e este cliente, em uma frase, nos termos da conversa."),
});

const AnaliseSchema = z.object({
  icp: IcpSchema.describe("Aderencia do CLIENTE ao perfil ideal."),
  temSinalComercial: z
    .boolean()
    .describe("Se ha qualquer indicio de intencao de compra nesta conversa."),
  resumoDaNecessidade: z
    .string()
    .describe(
      "O que o cliente precisa, em ate duas frases, nos termos dele. Se nao " +
        "der para saber, diga que nao da — nao preencha com suposicao.",
    ),
  produtoDeInteresse: z
    .string()
    .nullable()
    .describe("Produto ou servico citado. null quando nao houver."),
  sinais: z.array(SinalSchema).describe("Sinais encontrados, com evidencia."),
  objecoes: z
    .array(z.string())
    .describe("Objecoes levantadas pelo cliente, nas palavras dele."),
  proximoPasso: z
    .string()
    .describe(
      "A acao comercial mais util agora, concreta e executavel hoje. " +
        "Sem conselho generico.",
    ),
  valorMencionado: z
    .number()
    .nullable()
    .describe("Valor em reais explicitamente citado na conversa. null se nenhum."),
  justificativa: z
    .string()
    .describe("Por que esta conversa foi classificada assim, em uma frase."),
});

export type AnaliseDaIa = z.infer<typeof AnaliseSchema>;

/** Maximo de pontos de cada dimensao do ICP. Soma 100. */
export const PESOS_ICP = {
  fitDeNecessidade: 25,
  poderDeDecisao: 20,
  orcamento: 20,
  prazo: 20,
  engajamento: 15,
} as const;

export type DimensaoIcp = keyof typeof PESOS_ICP;

export interface IcpVerificado {
  /** 0 a 100. */
  total: number;
  faixa: "ALTO" | "MEDIO" | "BAIXO";
  perfilResumido: string;
  dimensoes: {
    chave: DimensaoIcp;
    rotulo: string;
    nota: number;
    maximo: number;
    justificativa: string;
    /** Trecho REAL da conversa. Ausente quando nada foi dito a respeito. */
    evidencia?: string;
    /**
     * true quando o modelo citou um trecho que nao existe. A nota vai a zero:
     * uma afirmacao sem lastro nao pode somar pontos.
     */
    evidenciaRejeitada: boolean;
  }[];
}

export const ROTULOS_ICP: Record<DimensaoIcp, string> = {
  fitDeNecessidade: "Fit de necessidade",
  poderDeDecisao: "Poder de decisão",
  orcamento: "Orçamento",
  prazo: "Prazo de compra",
  engajamento: "Engajamento",
};

export interface ResultadoDaAnalise {
  icp: IcpVerificado;
  sinais: DetectedSignal[];
  objecoes: string[];
  resumoDaNecessidade: string;
  produtoDeInteresse?: string;
  proximoPasso: string;
  valorMencionado?: number;
  justificativa: string;
  /** Sinais recusados por citarem trecho inexistente. */
  descartados: { codigo: string; trecho: string; motivo: string }[];
}

/* --------------------------------------------------------------------------
   Instrucoes
   -------------------------------------------------------------------------- */

/**
 * O prompt e montado UMA vez e nao varia entre conversas.
 *
 * Isso nao e estetica: prefixo estavel e o que permite o cache da API. Numa
 * varredura de 60 conversas, o catalogo e as regras sao reenviados 60 vezes —
 * com cache, a partir da segunda eles custam uma fracao.
 */
const CATALOGO = SIGNAL_CATALOG.map(
  (s) => `  ${s.code} (${s.polarity === "POSITIVE" ? "+" : "-"}) — ${s.label}`,
).join("\n");

const INSTRUCOES = `Voce e um analista comercial senior lendo atendimentos de uma empresa brasileira. Sua tarefa e identificar oportunidades de venda reais a partir do que foi efetivamente dito.

CATALOGO DE SINAIS — use exclusivamente estes codigos:
${CATALOGO}

REGRAS QUE NAO SE NEGOCIAM

1. Toda afirmacao sua precisa de um trecho LITERAL da conversa. Copie o texto exatamente como aparece, sem parafrasear e sem juntar pedacos distantes. Um trecho que nao existir na conversa faz o sinal inteiro ser descartado automaticamente — entao nao vale a pena arriscar.

2. Nunca classifique por palavra isolada. "Quanto custa?" numa conversa de suporte sobre um produto ja comprado nao e intencao de compra. "Valor" pode ser preco, pode ser beneficio. Leia a conversa inteira antes de decidir.

3. Distinga quem falou. Preco enviado PELO ATENDENTE e proposta enviada; preco pedido PELO CLIENTE e solicitacao. O campo quemDisse importa.

4. Reconheca a recusa educada. "Vou pensar e te falo", "depois eu vejo", "vou passar pro meu sócio" sem nenhuma continuidade costuma ser saida, nao maturidade comercial. Registre como objecao, nao como avanco.

5. Quando nao houver oportunidade, diga que nao ha. Uma lista vazia de sinais e uma resposta correta e util. Inflar a lista para parecer produtivo destroi a confianca de quem le a tela — e o time deixa de olhar a ferramenta.

6. Nao julgue pessoas. A analise orienta o proximo passo comercial; ela nao avalia o atendente.

7. Valores: apenas o que estiver escrito. Nao estime, nao extrapole de conversa parecida, nao converta. Se ninguem citou um numero, valorMencionado e null.

ICP — PERFIL DE CLIENTE IDEAL

Alem dos sinais, avalie o CLIENTE em cinco dimensoes. E uma pergunta diferente: nao "quanto este negocio esta quente", e sim "quanto esta pessoa se parece com quem costuma comprar".

Cada dimensao tem um maximo:
  Fit de necessidade  25   o que ele procura e o que esta empresa vende?
  Poder de decisao    20   ele decide sozinho?
  Orcamento           20   tem verba, e ela cabe?
  Prazo               20   quando pretende comprar?
  Engajamento         15   responde, manda dados, se envolve?

Regras especificas do ICP:

  a) Cada nota precisa do trecho que a sustenta, como os sinais. Trecho inexistente ZERA a dimensao.

  b) Um trecho nulo e resposta legitima e significa "a conversa nao falou disso". Nao invente um trecho para justificar uma nota — prefira null e nota baixa.

  c) Restricao de orcamento NAO zera a dimensao quando vier com data. "Nao tenho condicao agora, fica para o dia 5" e melhor que silencio: mostra intencao e prazo.

  d) Separe fit de temperatura. Um cliente que descreve exatamente o produto que a empresa vende tem fit ALTO mesmo que va comprar so no mes que vem.

CONTEXTO DE PRIVACIDADE
Telefones e e-mails chegam mascarados de proposito. Isso e esperado; nao comente a respeito e nao tente reconstrui-los.`;

/* --------------------------------------------------------------------------
   Preparo da conversa
   -------------------------------------------------------------------------- */

/** Mascara contato antes de a conversa sair do servidor. */
export function mascararContato(texto: string): string {
  return texto
    .replace(/\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, (m) => maskPhone(m) ?? "[telefone]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, (m) => maskEmail(m) ?? "[email]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[cnpj]");
}

/** Limite de mensagens enviadas por conversa. */
const MAX_MENSAGENS = 60;

interface MensagemPreparada {
  texto: string;
  original: string;
  id: string;
  sentAt: string;
  direction: "INBOUND" | "OUTBOUND";
}

function prepararMensagens(conversation: ConversationSnapshot): MensagemPreparada[] {
  return conversation.messages
    .filter((m) => m.text.trim().length > 0)
    // As mais recentes sao as que decidem o proximo passo.
    .slice(-MAX_MENSAGENS)
    .map((m) => ({
      texto: mascararContato(m.text),
      original: m.text,
      id: m.id,
      sentAt: m.sentAt,
      direction: m.direction,
    }));
}

function montarTranscricao(mensagens: MensagemPreparada[]): string {
  return mensagens
    .map((m, i) => {
      const quem = m.direction === "INBOUND" ? "CLIENTE" : "ATENDENTE";
      return `[${i + 1}] ${quem} (${m.sentAt}): ${m.texto}`;
    })
    .join("\n");
}

/* --------------------------------------------------------------------------
   Verificacao dos trechos
   -------------------------------------------------------------------------- */

/** Normaliza para comparar: sem acento, sem pontuacao, espacos colapsados. */
function normalizar(texto: string): string {
  return normalizarComMapa(texto).normalizado;
}

/**
 * Normaliza guardando, para cada caractere normalizado, de onde ele veio.
 *
 * O mapa e o que permite devolver o TEXTO ORIGINAL do trecho citado. Sem ele
 * so da para dizer "a citacao esta nesta mensagem", e o card acabava exibindo
 * os primeiros 280 caracteres da mensagem inteira. Numa conversa longa isso
 * mostra a abertura do audio em vez da frase que sustenta a conclusao — foi o
 * que aconteceu na conta real: a dimensao "Orcamento" citava um trecho sobre
 * placas-mae, e tres dimensoes diferentes exibiam exatamente o mesmo texto.
 */
function normalizarComMapa(texto: string): {
  normalizado: string;
  origem: number[];
} {
  const saida: string[] = [];
  const origem: number[] = [];

  const minusculo = texto.toLowerCase();

  for (let i = 0; i < minusculo.length; i += 1) {
    const bruto = minusculo[i] as string;

    // NFD por caractere: assim um "a" com acento continua ocupando UMA
    // posicao de origem, e o mapa nao se desalinha.
    const semAcento = bruto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (semAcento.length === 0) continue;

    const ehPalavra = /[\w]/.test(semAcento);
    const ehEspaco = /\s/.test(semAcento);
    const caractere = ehPalavra ? semAcento : ehEspaco ? " " : " ";

    if (caractere === " ") {
      // Espacos colapsados: nao emite dois seguidos nem um no inicio.
      if (saida.length === 0 || saida[saida.length - 1] === " ") continue;
      saida.push(" ");
      origem.push(i);
      continue;
    }

    for (const parte of caractere) {
      saida.push(parte);
      origem.push(i);
    }
  }

  // Espaco final, se houver, nao faz parte da comparacao.
  while (saida.length > 0 && saida[saida.length - 1] === " ") {
    saida.pop();
    origem.pop();
  }

  return { normalizado: saida.join(""), origem };
}

/**
 * Encontra a mensagem que contem o trecho citado.
 *
 * A comparacao e tolerante a acento e pontuacao — o modelo pode normalizar
 * aspas ou reticencias ao copiar — mas NAO a conteudo. Um trecho que nao
 * aparece em nenhuma mensagem nao encontra ancora, e o sinal cai.
 */
/** Tamanho maximo da evidencia exibida no card. */
const LIMITE_DA_EVIDENCIA = 280;

interface Ancora {
  mensagem: MensagemPreparada;
  /**
   * A evidencia que vai para a tela — sempre texto real da conversa.
   *
   * Mensagem curta aparece inteira: o contexto em volta da frase e util e
   * cabe. Mensagem longa — um audio transcrito tem paragrafos — aparece como
   * uma janela em volta da citacao, porque cortar nos primeiros 280
   * caracteres mostra a abertura do audio em vez da frase que sustenta a
   * conclusao. Na conta real isso fez a dimensao "Orcamento" citar um trecho
   * sobre placas-mae e tres dimensoes diferentes exibirem o mesmo texto.
   */
  evidencia: string;
}

/**
 * Recorta a evidencia: mensagem inteira quando cabe, janela em volta da
 * citacao quando nao cabe.
 */
function recortarEvidencia(texto: string, inicio: number, fim: number): string {
  if (texto.length <= LIMITE_DA_EVIDENCIA) return texto.trim();

  const citacao = fim - inicio;

  // A citacao sozinha ja estoura o limite: corta nela mesma.
  if (citacao >= LIMITE_DA_EVIDENCIA) {
    return texto.slice(inicio, inicio + LIMITE_DA_EVIDENCIA).trim() + "...";
  }

  const folga = Math.floor((LIMITE_DA_EVIDENCIA - citacao) / 2);
  const de = Math.max(0, inicio - folga);
  const ate = Math.min(texto.length, fim + folga);

  const janela = texto.slice(de, ate).trim();

  return (de > 0 ? "..." : "") + janela + (ate < texto.length ? "..." : "");
}

function ancorar(trecho: string, mensagens: MensagemPreparada[]): Ancora | undefined {
  const alvo = normalizar(trecho);
  if (alvo.length < 8) return undefined; // trecho curto demais nao prova nada

  for (const mensagem of mensagens) {
    const { normalizado, origem } = normalizarComMapa(mensagem.texto);
    const inicio = normalizado.indexOf(alvo);
    if (inicio === -1) continue;

    const primeiro = origem[inicio];
    const ultimo = origem[inicio + alvo.length - 1];
    if (primeiro === undefined || ultimo === undefined) continue;

    return {
      mensagem,
      evidencia: recortarEvidencia(mensagem.texto, primeiro, ultimo + 1),
    };
  }

  return undefined;
}

const CODIGOS_VALIDOS = new Map(SIGNAL_CATALOG.map((s) => [s.code, s]));

/**
 * Converte a analise do modelo em sinais auditaveis, descartando o que nao
 * se sustenta. Esta funcao e pura: da para testa-la sem chamar a API.
 */
export function verificarAnalise(
  analise: AnaliseDaIa,
  mensagens: MensagemPreparada[],
): ResultadoDaAnalise {
  const sinais: DetectedSignal[] = [];
  const descartados: ResultadoDaAnalise["descartados"] = [];
  const jaVistos = new Set<string>();

  for (const bruto of analise.sinais) {
    const doCatalogo = CODIGOS_VALIDOS.get(bruto.codigo);

    if (!doCatalogo) {
      descartados.push({
        codigo: bruto.codigo,
        trecho: bruto.trecho,
        motivo: "codigo fora do catalogo curado",
      });
      continue;
    }

    const ancora = ancorar(bruto.trecho, mensagens);
    if (!ancora) {
      descartados.push({
        codigo: bruto.codigo,
        trecho: bruto.trecho,
        motivo: "trecho nao encontrado na conversa",
      });
      continue;
    }

    // O mesmo codigo duas vezes nao vale o dobro.
    if (jaVistos.has(doCatalogo.code)) continue;
    jaVistos.add(doCatalogo.code);

    sinais.push({
      code: doCatalogo.code,
      label: doCatalogo.label,
      polarity: doCatalogo.polarity,
      // O trecho guardado e o da MENSAGEM, nao o que o modelo digitou:
      // assim a evidencia exibida e sempre texto real da conversa.
      excerpt: ancora.evidencia,
      messageId: ancora.mensagem.id,
      sentAt: ancora.mensagem.sentAt,
      strength: Math.min(1, Math.max(0, bruto.forca)),
    });
  }

  /*
   * ICP verificado dimensao por dimensao.
   *
   * A mesma regra dos sinais vale aqui, e pelo mesmo motivo: uma nota alta
   * com justificativa convincente e trecho inexistente e exatamente o tipo de
   * coisa que leva um vendedor a priorizar o cliente errado.
   *
   * `trecho: null` NAO e rejeicao — e a conversa nao ter falado do assunto,
   * que e uma observacao legitima e costuma vir com nota baixa. Rejeicao e
   * citar algo que ninguem disse; ai a nota vai a zero.
   */
  const dimensoes: IcpVerificado["dimensoes"] = (
    Object.keys(PESOS_ICP) as DimensaoIcp[]
  ).map((chave) => {
    const bruta = analise.icp[chave];
    const maximo = PESOS_ICP[chave];

    const ancora = bruta.trecho ? ancorar(bruta.trecho, mensagens) : undefined;
    const evidenciaRejeitada = Boolean(bruta.trecho) && !ancora;

    const nota = evidenciaRejeitada
      ? 0
      : Math.round(Math.min(maximo, Math.max(0, bruta.nota)));

    if (evidenciaRejeitada) {
      descartados.push({
        codigo: `ICP:${chave}`,
        trecho: bruta.trecho ?? "",
        motivo: "trecho nao encontrado na conversa",
      });
    }

    return {
      chave,
      rotulo: ROTULOS_ICP[chave],
      nota,
      maximo,
      justificativa: evidenciaRejeitada
        ? "A justificativa citava um trecho que nao existe na conversa; a nota foi zerada."
        : bruta.justificativa,
      ...(ancora ? { evidencia: ancora.evidencia } : {}),
      evidenciaRejeitada,
    };
  });

  const totalIcp = dimensoes.reduce((acc, d) => acc + d.nota, 0);

  const icp: IcpVerificado = {
    total: totalIcp,
    faixa: totalIcp >= 70 ? "ALTO" : totalIcp >= 40 ? "MEDIO" : "BAIXO",
    perfilResumido: analise.icp.perfilResumido,
    dimensoes,
  };

  return {
    icp,
    sinais,
    objecoes: analise.objecoes,
    resumoDaNecessidade: analise.resumoDaNecessidade,
    ...(analise.produtoDeInteresse
      ? { produtoDeInteresse: analise.produtoDeInteresse }
      : {}),
    proximoPasso: analise.proximoPasso,
    ...(analise.valorMencionado !== null
      ? { valorMencionado: analise.valorMencionado }
      : {}),
    justificativa: analise.justificativa,
    descartados,
  };
}

/* --------------------------------------------------------------------------
   Chamada
   -------------------------------------------------------------------------- */

export class AiIndisponivelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiIndisponivelError";
  }
}

export async function analisarConversa(params: {
  conversation: ConversationSnapshot;
  contactName: string;
  signal?: AbortSignal;
}): Promise<ResultadoDaAnalise | null> {
  const client = getAiClient();
  if (!client) return null;

  const mensagens = prepararMensagens(params.conversation);

  // Sem texto nao ha o que ler — e uma chamada que so gastaria dinheiro.
  if (mensagens.length === 0) return null;

  const transcricao = montarTranscricao(mensagens);

  try {
    const resposta = await client.messages.parse({
        model: getModelo(),
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        // Esforco baixo por padrao: ver client.ts. A medicao contra a conta
        // real mostrou que o esforco alto custava 53 das 57 conversas.
        output_config: { effort: getEsforco(), format: zodOutputFormat(AnaliseSchema) },
        // As instrucoes e o catalogo sao identicos em toda conversa da
        // varredura: marcar o prefixo como cacheavel evita reenviar o mesmo
        // conteudo dezenas de vezes por analise.
        system: [
          { type: "text", text: INSTRUCOES, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content:
              `Atendimento com ${params.contactName}, canal ${params.conversation.channel}.\n\n` +
              `${transcricao}\n\n` +
              `Analise este atendimento conforme as regras.`,
          },
        ],
      },
      params.signal ? { signal: params.signal } : undefined,
    );

    const analise = resposta.parsed_output;
    if (!analise) return null;

    return verificarAnalise(analise, mensagens);
  } catch (erro) {
    if (erro instanceof Anthropic.AuthenticationError) {
      throw new AiIndisponivelError(
        "A credencial da IA foi recusada. Confira AI_PROVIDER_API_KEY.",
      );
    }
    if (erro instanceof Anthropic.RateLimitError) {
      throw new AiIndisponivelError(
        "Limite de requisicoes da IA atingido. A analise continua sem ela.",
      );
    }
    if (erro instanceof Anthropic.APIError) {
      throw new AiIndisponivelError(`A IA respondeu ${erro.status}: ${erro.message}`);
    }
    throw erro;
  }
}

/** Exportado para teste: o preparo e deterministico e vale conferir. */
export const paraTeste = { prepararMensagens, mascarar: mascararContato, normalizar, ancorar };
