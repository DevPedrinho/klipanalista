import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  AiIndisponivelError,
  type Analista,
  type PedidoDeAnalise,
  type RespostaDoAnalista,
} from "../provedor";

/**
 * Provedor Anthropic.
 *
 * A chamada aqui e a mesma que vinha de dentro do analista, sem nenhuma
 * mudanca de comportamento: `messages.parse` com formato derivado do proprio
 * schema, raciocinio adaptativo, e o prefixo do `system` marcado como
 * cacheavel — as instrucoes e o catalogo de sinais sao identicos em toda
 * conversa da varredura, e reenvia-los dezenas de vezes por analise seria
 * pagar duas vezes pelo mesmo texto.
 */

/** Teto de saida. A analise devolve um objeto, nao um texto longo. */
const MAX_TOKENS = 16_000;

export function criarAnalistaAnthropic(params: {
  apiKey: string;
  modelo: string;
}): Analista {
  const cliente = new Anthropic({ apiKey: params.apiKey });

  return {
    provedor: "anthropic",
    modelo: params.modelo,

    async analisar(pedido: PedidoDeAnalise): Promise<RespostaDoAnalista> {
      try {
        const resposta = await cliente.messages.parse(
          {
            model: params.modelo,
            max_tokens: MAX_TOKENS,
            thinking: { type: "adaptive" },
            output_config: {
              effort: pedido.esforco,
              format: zodOutputFormat(pedido.schema),
            },
            system: [
              { type: "text", text: pedido.sistema, cache_control: { type: "ephemeral" } },
            ],
            messages: [{ role: "user", content: pedido.usuario }],
          },
          pedido.signal ? { signal: pedido.signal } : undefined,
        );

        return {
          saida: resposta.parsed_output,
          provedor: "anthropic",
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
 * So `AiIndisponivelError` autoriza cair para o outro provedor, entao o que
 * entra nessa categoria importa: credencial, limite de vazao e qualquer
 * recusa da API — inclusive a de credito no fim, que chega como 400 e nao
 * tem classe propria no SDK.
 */
function traduzir(erro: unknown): unknown {
  if (erro instanceof Anthropic.AuthenticationError) {
    return new AiIndisponivelError(
      "anthropic",
      "A credencial da Anthropic foi recusada. Confira AI_PROVIDER_API_KEY.",
    );
  }
  if (erro instanceof Anthropic.RateLimitError) {
    return new AiIndisponivelError(
      "anthropic",
      "Limite de requisicoes da Anthropic atingido.",
    );
  }
  if (erro instanceof Anthropic.APIError) {
    return new AiIndisponivelError(
      "anthropic",
      `A Anthropic respondeu ${erro.status}: ${erro.message}`,
    );
  }
  return erro;
}
