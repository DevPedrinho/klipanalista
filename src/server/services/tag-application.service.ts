import "server-only";
import { contactsAdapter, tagsAdapter } from "@/server/integration/adapters";
import { ApiError } from "@/server/integration/http/client";
import type { SuggestedAccountTag } from "@/domain/types";

export interface ResultadoDaExecucao {
  status: "EXECUTADA" | "SIMULADA" | "FALHOU";
  apiResult: { ok: boolean; message: string };
  /** O estado real depois da escrita, quando a API o devolve. */
  depois?: Record<string, unknown> | null;
  notice: string;
}

/**
 * Aplica ao contato as etiquetas sugeridas — todas do vocabulario da conta.
 *
 * Tres regras sustentam esta ser a primeira escrita ligada:
 *
 *  1. SO REUTILIZA. Toda sugestao nasce da listagem de etiquetas da conta e
 *     e reconferida contra ela antes do envio. O pedido leva `tagIds`, nunca
 *     `tagNames` — e `tagNames` que faria a plataforma criar etiqueta nova.
 *
 *  2. SO ACRESCENTA. O adapter envia `InsertIfNotExists`. Etiqueta que a
 *     equipe marcou a mao continua onde estava, e reenviar a mesma lista nao
 *     produz efeito — a operacao e idempotente do lado da API.
 *
 *  3. NAO DERRUBA A TELA. Se a API recusar, a falha vira um resultado
 *     descrito, gravado na auditoria com o que a API respondeu. Um erro de
 *     escrita numa acao nao pode virar erro 500 numa pagina de analise.
 */
export async function aplicarEtiquetas(params: {
  accountId: string;
  contactId: string;
  contactName: string;
  /** Etiquetas da propria conta, ja sugeridas para esta oportunidade. */
  sugeridas: SuggestedAccountTag[];
}): Promise<ResultadoDaExecucao> {
  if (!params.contactId) {
    return {
      status: "FALHOU",
      apiResult: { ok: false, message: "A oportunidade nao tem contato vinculado." },
      notice:
        "Nao foi possivel aplicar: esta oportunidade nao tem um contato vinculado na " +
        "plataforma.",
    };
  }

  /*
   * As sugestoes vem com o id que a conta usa, mas a lista pode ter sido
   * montada ha minutos. Conferir contra a listagem atual custa uma chamada e
   * impede que uma etiqueta apagada nesse meio-tempo vire um erro obscuro da
   * API.
   */
  const existentes = await tagsAdapter.list({ accountId: params.accountId });
  const idsValidos = new Map(existentes.data.map((t) => [t.id, t.name]));

  const validas = params.sugeridas.filter((s) => idsValidos.has(s.tagId));
  const sumidas = params.sugeridas.filter((s) => !idsValidos.has(s.tagId));

  if (validas.length === 0) {
    // Nada a enviar nao e sucesso nem erro: e uma situacao que a tela precisa
    // explicar, para ninguem achar que aplicou.
    return {
      status: "FALHOU",
      apiResult: {
        ok: false,
        message:
          params.sugeridas.length === 0
            ? "Nenhuma etiqueta da conta foi sugerida para esta oportunidade."
            : `As etiquetas sugeridas nao existem mais na conta: ${sumidas
                .map((s) => s.tagName)
                .join(", ")}.`,
      },
      notice:
        params.sugeridas.length === 0
          ? "Nenhuma etiqueta desta conta se aplica a esta conversa."
          : "As etiquetas sugeridas nao existem mais na conta. Recarregue a analise.",
    };
  }

  const tagIds = validas.map((s) => s.tagId);

  try {
    const resposta = await contactsAdapter.applyTags({
      accountId: params.accountId,
      contactId: params.contactId,
      tagIds,
      dryRun: false,
    });

    if (!resposta.data.applied) {
      return {
        status: "FALHOU",
        apiResult: {
          ok: false,
          message: resposta.data.reason ?? "A API nao confirmou a aplicacao.",
        },
        notice: resposta.data.reason ?? "A plataforma nao confirmou a aplicacao das etiquetas.",
      };
    }

    const nomes = validas.map((s) => s.tagName);

    return {
      status: "EXECUTADA",
      apiResult: {
        ok: true,
        message:
          `${tagIds.length} etiqueta(s) aplicada(s) ao contato via ` +
          "POST /v1/contact/{id}/tags com operacao InsertIfNotExists.",
      },
      // A API devolve o contato inteiro; guardamos a lista confirmada por ela,
      // nao a que pedimos.
      depois: {
        // O motivo vai junto: a auditoria precisa explicar por que cada
        // etiqueta entrou, nao so que entrou.
        etiquetasAplicadas: validas.map((s) => ({
          nome: s.tagName,
          motivo: s.motivo,
          origem: s.origem,
        })),
        etiquetasNoContatoDepois: resposta.data.tagIds ?? null,
      },
      notice:
        `${tagIds.length} etiqueta(s) aplicada(s) em ${params.contactName}: ${nomes.join(", ")}.`,
    };
  } catch (erro) {
    const apiErro = erro instanceof ApiError ? erro : null;

    const detalhe = apiErro
      ? `${apiErro.kind}${apiErro.statusCode ? ` (HTTP ${apiErro.statusCode})` : ""}: ${apiErro.message}`
      : erro instanceof Error
        ? erro.message
        : String(erro);

    return {
      status: "FALHOU",
      apiResult: { ok: false, message: detalhe },
      notice: `A plataforma recusou a aplicacao das etiquetas. ${detalhe}`,
    };
  }
}
