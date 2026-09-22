import "server-only";
import type * as z from "zod/v4";
import type { EsforcoDaIa } from "./client";

/**
 * Contrato do provedor de IA.
 *
 * POR QUE ESTA CAMADA EXISTE
 *
 * A leitura por IA era uma chamada direta ao SDK da Anthropic, dentro do
 * analista. Duas coisas pediram para separar:
 *
 *   CUSTO. Escolher um modelo mais barato exige poder escolher — e hoje a
 *   unica alavanca era o esforco, ja em `low` por esse motivo.
 *
 *   DISPONIBILIDADE. Quando o credito da Anthropic acabou, a leitura por IA
 *   parou inteira. Com dois provedores isso vira contratempo, nao parada.
 *
 * O QUE ESTA CAMADA NAO DECIDE
 *
 * Nada sobre a qualidade da analise. A garantia do modulo — nenhuma
 * afirmacao sem um trecho literal que exista mesmo na conversa — e imposta
 * DEPOIS, por `verificarAnalise`, que so olha o objeto ja convertido e as
 * mensagens reais. Por isso trocar de provedor nao pode enfraquece-la: um
 * modelo pior apenas tem mais afirmacoes descartadas, e essa contagem ja
 * aparece na tela.
 */

export const PROVEDORES = ["anthropic", "openai"] as const;
export type NomeDoProvedor = (typeof PROVEDORES)[number];

export function ehProvedor(valor: string): valor is NomeDoProvedor {
  return (PROVEDORES as readonly string[]).includes(valor);
}

/**
 * O provedor nao pode atender agora.
 *
 * Distinta de qualquer outro erro de proposito: e esta, e somente esta, que
 * autoriza tentar o outro provedor. Um erro de formato da resposta e problema
 * de conteudo, nao de disponibilidade — trocar de provedor nao consertaria e
 * so gastaria dinheiro duas vezes.
 */
export class AiIndisponivelError extends Error {
  readonly provedor: NomeDoProvedor;

  constructor(provedor: NomeDoProvedor, message: string) {
    super(message);
    this.name = "AiIndisponivelError";
    this.provedor = provedor;
  }
}

export interface PedidoDeAnalise {
  /**
   * Prefixo estavel: identico em toda conversa da varredura.
   *
   * Vem separado do resto justamente por isso — e o que cada provedor pode
   * tratar como cacheavel, do jeito dele.
   */
  sistema: string;
  /** A parte que muda a cada conversa. */
  usuario: string;
  /** Forma esperada da resposta. */
  schema: z.ZodType;
  esforco: EsforcoDaIa;
  signal?: AbortSignal;
}

export interface RespostaDoAnalista {
  /**
   * O objeto devolvido pelo modelo, ainda NAO verificado contra a conversa.
   *
   * `unknown` de proposito: quem chama valida com o proprio schema, e assim
   * toda saida passa pela mesma porta, venha do provedor que vier. Confiar na
   * conversao do SDK deixaria cada provedor com uma garantia diferente.
   */
  saida: unknown;
  /** Quem efetivamente atendeu — pode nao ser o principal. */
  provedor: NomeDoProvedor;
  modelo: string;
}

export interface Analista {
  readonly provedor: NomeDoProvedor;
  readonly modelo: string;
  analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalista>;
}

/**
 * Junta um provedor principal e um reserva.
 *
 * So cai para o reserva quando o principal levanta `AiIndisponivelError` —
 * credencial recusada, limite atingido, credito no fim. Qualquer outro erro
 * sobe, porque repetir num segundo provedor nao resolveria.
 *
 * A resposta carrega quem atendeu, entao a troca aparece nas estatisticas em
 * vez de acontecer em silencio. Uma queda silenciosa esconderia justamente a
 * informacao que se quer ter: que o provedor principal parou.
 */
export function comReserva(principal: Analista, reserva?: Analista): Analista {
  if (!reserva) return principal;

  return {
    provedor: principal.provedor,
    modelo: principal.modelo,

    async analisar(pedido) {
      try {
        return await principal.analisar(pedido);
      } catch (erro) {
        if (!(erro instanceof AiIndisponivelError)) throw erro;

        // Interrupcao por prazo nao e falha do provedor: tentar o reserva so
        // gastaria o orcamento que ja acabou.
        if (pedido.signal?.aborted) throw erro;

        return await reserva.analisar(pedido);
      }
    },
  };
}
