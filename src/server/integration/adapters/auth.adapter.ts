import "server-only";
import { getEnv } from "@/server/config/env";
import { ENDPOINTS } from "../endpoints";

/**
 * AuthAdapter — login integrado.
 *
 * A documentacao confirma que o recurso EXISTE:
 *   "Login integrado: e possivel integrar o login entre plataformas, gerando
 *    um token via API e direcionando o usuario."
 *
 * PENDENTE DE VALIDACAO: o metodo, o caminho, o corpo e o formato do token
 * NAO constam do indice publico. Fonte a confirmar:
 *   https://flwchat.readme.io/reference/login-integrado.md
 *
 * ATE LA, este adapter NAO chama a API e NAO inventa um token. Ele devolve
 * a URL relativa do atendimento e diz explicitamente que o login integrado
 * ainda nao esta disponivel — para que a UI possa abrir a conversa pedindo
 * que o usuario ja esteja logado, em vez de falhar.
 */

export interface DeepLinkResult {
  /** URL final para abrir o atendimento. */
  url: string;
  /** true somente quando o token de login integrado foi realmente gerado. */
  integratedLogin: boolean;
  /** Explicacao exibida ao usuario quando o login integrado nao esta ativo. */
  notice?: string;
  pendingValidation: string[];
}

/**
 * Caminho da conversa dentro da plataforma.
 * Informado no briefing do produto: /chat2/sessions/{sessionId}/preview?interactive=true
 * PENDENTE DE VALIDACAO: confirmar que este caminho vale para a instancia
 * do cliente (pode variar por dominio de conta).
 */
export function buildSessionPath(sessionId: string): string {
  return `/chat2/sessions/${encodeURIComponent(sessionId)}/preview?interactive=true`;
}

export const authAdapter = {
  /**
   * Monta o link para abrir um atendimento.
   *
   * Executa SOMENTE no servidor: e aqui que o token de login integrado seria
   * gerado quando o endpoint for confirmado. O frontend jamais monta este link.
   */
  async buildSessionDeepLink(params: {
    accountId: string;
    userId: string;
    sessionId: string;
  }): Promise<DeepLinkResult> {
    const env = getEnv();
    const contract = ENDPOINTS.AUTH.INTEGRATED_LOGIN;
    const hasOverride = Boolean(process.env[`FLW_EP_${contract.key}`]);

    const platformBase = env.chatApiUrl ?? env.coreApiUrl;
    const path = buildSessionPath(params.sessionId);

    if (!hasOverride) {
      return {
        url: platformBase ? `${platformBase}${path}` : path,
        integratedLogin: false,
        notice:
          "Login integrado ainda nao configurado. O atendimento abrira na " +
          "KlipFlowi e exigira que voce ja esteja autenticado na plataforma.",
        pendingValidation: contract.pending,
      };
    }

    // Caminho confirmado por variavel de ambiente: a geracao do token deve
    // ser implementada aqui, no servidor, apos validar o contrato real.
    // Nao ha implementacao especulativa: sem contrato confirmado, sem chamada.
    return {
      url: platformBase ? `${platformBase}${path}` : path,
      integratedLogin: false,
      notice:
        "Caminho de login integrado informado por ambiente, mas o formato do " +
        "corpo e da resposta ainda precisa ser implementado apos confirmacao " +
        "da documentacao.",
      pendingValidation: contract.pending,
    };
  },
};
