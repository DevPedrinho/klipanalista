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

const AnaliseSchema = z.object({
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

export interface ResultadoDaAnalise {
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
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Encontra a mensagem que contem o trecho citado.
 *
 * A comparacao e tolerante a acento e pontuacao — o modelo pode normalizar
 * aspas ou reticencias ao copiar — mas NAO a conteudo. Um trecho que nao
 * aparece em nenhuma mensagem nao encontra ancora, e o sinal cai.
 */
function ancorar(
  trecho: string,
  mensagens: MensagemPreparada[],
): MensagemPreparada | undefined {
  const alvo = normalizar(trecho);
  if (alvo.length < 8) return undefined; // trecho curto demais nao prova nada

  return mensagens.find((m) => normalizar(m.texto).includes(alvo));
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
      excerpt: ancora.texto.slice(0, 280),
      messageId: ancora.id,
      sentAt: ancora.sentAt,
      strength: Math.min(1, Math.max(0, bruto.forca)),
    });
  }

  return {
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
