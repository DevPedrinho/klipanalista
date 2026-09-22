import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  AiIndisponivelError,
  type Analista,
  type PedidoDeAnalise,
  type RespostaDoAnalista,
} from "../provedor";

/**
 * Provedor OpenAI.
 *
 * ONDE ELE DIFERE DA ANTHROPIC, E POR QUE ISSO NAO E DISFARCADO
 *
 * O cache de prompt aqui e AUTOMATICO: nao ha como marcar o prefixo estavel,
 * a plataforma reconhece sozinha o inicio repetido. Por isso o `sistema` do
 * pedido entra como instrucao e nada mais precisa ser feito — mas tambem nao
 * ha garantia declarada de que o cache pegou, ao contrario do outro lado.
 *
 * Nao existe equivalente exato do raciocinio adaptativo. O que existe e o
 * esforco, que so vale em modelo de raciocinio; num modelo comum o campo e
 * ignorado. Fingir paridade aqui produziria uma configuracao que parece valer
 * e nao vale.
 *
 * O que e igual, e e o que importa: a saida sai no formato do mesmo schema
 * zod, e passa pela MESMA verificacao contra a conversa depois.
 */

export function criarAnalistaOpenAi(params: {
  apiKey: string;
  modelo: string;
}): Analista {
  const cliente = new OpenAI({ apiKey: params.apiKey });

  return {
    provedor: "openai",
    modelo: params.modelo,

    async analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalista> {
      try {
        const resposta = await cliente.responses.parse(
          {
            model: params.modelo,
            instructions: pedido.sistema,
            input: pedido.usuario,
            text: { format: zodTextFormat(pedido.schema, "analise") },
            // Vale em modelo de raciocinio; nos demais e ignorado pela API.
            reasoning: { effort: pedido.esforco },
          },
          pedido.signal ? { signal: pedido.signal } : undefined,
        );

        return {
          saida: resposta.output_parsed,
          provedor: "openai",
          modelo: params.modelo,
        };
      } catch (erro) {
        throw traduzir(erro);
      }
    },
  };
}

/**
 * Converte o erro do SDK em vocabulario do modulo.
 *
 * So `AiIndisponivelError` autoriza cair para o outro provedor. Aqui entram
 * credencial, limite de vazao e qualquer recusa da API — inclusive cota
 * esgotada, que chega como 429 junto com o limite comum.
 */
function traduzir(erro: unknown): unknown {
  if (erro instanceof OpenAI.AuthenticationError) {
    return new AiIndisponivelError(
      "openai",
      "A credencial da OpenAI foi recusada. Confira OPENAI_API_KEY.",
    );
  }
  if (erro instanceof OpenAI.RateLimitError) {
    return new AiIndisponivelError(
      "openai",
      "Limite ou cota da OpenAI atingido.",
    );
  }
  if (erro instanceof OpenAI.APIError) {
    return new AiIndisponivelError(
      "openai",
      `A OpenAI respondeu ${erro.status}: ${erro.message}`,
    );
  }
  return erro;
}
