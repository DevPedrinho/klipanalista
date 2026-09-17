import "server-only";
import { contactsAdapter, tagsAdapter } from "@/server/integration/adapters";
import { ApiError } from "@/server/integration/http/client";
import { resolveTags } from "./tag-taxonomy.service";

export interface ResultadoDaExecucao {
  status: "EXECUTADA" | "SIMULADA" | "FALHOU";
  apiResult: { ok: boolean; message: string };
  /** O estado real depois da escrita, quando a API o devolve. */
  depois?: Record<string, unknown> | null;
  notice: string;
}

/**
 * Aplica ao contato as etiquetas que a IA recomendou.
 *
 * Tres regras sustentam esta ser a primeira escrita ligada:
 *
 *  1. SO REUTILIZA. Apenas etiquetas que ja existem na conta sao enviadas.
 *     As que nao existem ficam pendentes de aprovacao administrativa — a IA
 *     nunca cria etiqueta por conta propria, nem aqui nem em lugar nenhum.
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
  tagKeys: string[];
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

  const existentes = await tagsAdapter.list({ accountId: params.accountId });
  const resolucoes = resolveTags(params.tagKeys, existentes.data);

  const reutilizadas = resolucoes.filter((r) => r.matched);
  const pendentes = resolucoes.filter((r) => r.outcome === "NEEDS_APPROVAL");

  if (reutilizadas.length === 0) {
    // Nada a enviar nao e sucesso nem erro: e uma situacao que a tela precisa
    // explicar, para ninguem achar que aplicou.
    return {
      status: "FALHOU",
      apiResult: {
        ok: false,
        message:
          "Nenhuma etiqueta equivalente existe na conta. " +
          `Pendentes de aprovacao: ${pendentes.map((r) => r.canonicalName).join(", ") || "nenhuma"}.`,
      },
      notice:
        pendentes.length > 0
          ? `Nenhuma etiqueta foi aplicada: as ${pendentes.length} recomendadas ainda nao ` +
            "existem nesta conta e precisam de aprovacao administrativa para serem criadas."
          : "Nenhuma etiqueta recomendada para esta oportunidade.",
    };
  }

  const tagIds = reutilizadas
    .map((r) => r.matched?.id)
    .filter((id): id is string => typeof id === "string");

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

    const nomes = reutilizadas.map((r) => r.matched?.name).filter(Boolean);

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
        etiquetasAplicadas: nomes,
        etiquetasNoContatoDepois: resposta.data.tagIds ?? null,
        etiquetasPendentesDeAprovacao: pendentes.map((r) => r.canonicalName),
      },
      notice:
        `${tagIds.length} etiqueta(s) aplicada(s) em ${params.contactName}: ${nomes.join(", ")}.` +
        (pendentes.length > 0
          ? ` Outras ${pendentes.length} nao existem na conta e aguardam aprovacao.`
          : ""),
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
