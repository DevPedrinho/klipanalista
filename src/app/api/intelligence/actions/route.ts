import { type NextRequest } from "next/server";
import { z } from "zod";
import { ACTION_TYPES } from "@/domain/enums";
import { agentsAdapter, contactsAdapter, tagsAdapter } from "@/server/integration/adapters";
import {
  aplicarEtiquetas,
  type ResultadoDaExecucao,
} from "@/server/services/tag-application.service";
import { fail, failValidation, handleError, ok } from "@/server/http/respond";
import { recordAudit } from "@/server/services/audit.service";
import {
  ACTION_LABELS,
  decideAction,
} from "@/server/services/automation.service";
import { loadOverview } from "@/server/services/intelligence.service";
import { getSettings } from "@/server/services/settings.service";
import { resolveTags } from "@/server/services/tag-taxonomy.service";
import {
  buildTenantContext,
  canApproveActions,
  resolvePeriod,
} from "@/server/security/tenant-context";

/**
 * POST /api/intelligence/actions
 *
 * Prepara uma acao sugerida pela IA e devolve a PREVIA do que aconteceria.
 *
 * ESCRITA REAL — hoje so APLICAR_ETIQUETAS.
 *
 * Todas as demais acoes continuam em simulacao: registram a intencao na
 * auditoria e devolvem o diff proposto, sem tocar a API. Elas serao ligadas
 * uma a uma, conforme cada contrato de escrita for confirmado na
 * documentacao (ver src/server/integration/endpoints.ts).
 *
 * As etiquetas vieram primeiro porque sao a acao de menor risco com o
 * contrato mais solido: o endpoint aparece com URL literal na documentacao,
 * a operacao enviada e `InsertIfNotExists` (apenas acrescenta — nunca apaga
 * o que a equipe marcou a mao), e o efeito e reversivel em um clique dentro
 * da propria KlipFlowi.
 *
 * Tres travas continuam valendo para ela:
 *   1. o modo de automacao decide (OBSERVADOR bloqueia);
 *   2. no modo Copiloto uma pessoa confirma antes;
 *   3. so entram etiquetas que JA existem na conta — criar exige aprovacao
 *      administrativa, e a IA nunca cria por conta propria.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  opportunityId: z.string().min(1).max(200),
  actionType: z.enum(ACTION_TYPES),
  /** Confirmacao humana explicita vinda do modal. */
  confirmed: z.boolean().default(false),
  /** Campos editados pelo usuario antes de confirmar. */
  overrides: z
    .object({
      stepName: z.string().max(120).optional(),
      responsibleId: z.string().max(128).optional(),
      amount: z.number().nonnegative().optional(),
      followUpDate: z.string().max(40).optional(),
      note: z.string().max(2000).optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) return failValidation(parsed.error.issues);
    const input = parsed.data;

    const users = await agentsAdapter.list({ accountId: input.accountId });
    const context = buildTenantContext({
      accountId: input.accountId,
      userId: input.userId,
      allUsers: users.data,
    });

    const requester = users.data.find((u) => u.id === context.userId);
    const settings = getSettings(context.accountId);

    /* --- Localiza a oportunidade DENTRO do escopo do usuario ------------- */
    const overview = await loadOverview({
      context,
      filters: { period: resolvePeriod({ preset: "90d" }) },
    });

    const opportunity = overview.opportunities.find((o) => o.id === input.opportunityId);
    if (!opportunity) {
      // Nao revela se a oportunidade existe em outro escopo.
      return fail(
        "SEM_PERMISSAO",
        "Oportunidade nao encontrada no seu escopo de visualizacao.",
      );
    }

    /* --- Decide o que pode acontecer ------------------------------------- */
    const decision = decideAction({
      actionType: input.actionType,
      settings,
      role: context.role,
    });

    if (decision.outcome === "BLOQUEADA") {
      recordAudit({
        accountId: context.accountId,
        requestedByUserId: context.userId,
        requestedByName: requester?.name ?? context.userId,
        actionType: input.actionType,
        actionStatus: "BLOQUEADA_POR_MODO",
        targetKind: "OPORTUNIDADE",
        targetId: opportunity.id,
        targetLabel: opportunity.contactName,
        suggestion: ACTION_LABELS[input.actionType],
        evidenceCodes: opportunity.evidence.map((e) => e.code),
        before: null,
        after: null,
        aiConfidence: opportunity.confidence,
        automationMode: settings.automationMode,
        success: false,
      });
      return fail("SEM_PERMISSAO", decision.reason);
    }

    /* --- Exige confirmacao quando aplicavel ------------------------------ */
    const needsConfirmation = decision.outcome === "EXIGE_CONFIRMACAO";

    if (needsConfirmation && !input.confirmed) {
      const preview = await buildPreview({
        accountId: context.accountId,
        opportunity,
        actionType: input.actionType,
        overrides: input.overrides,
      });

      recordAudit({
        accountId: context.accountId,
        requestedByUserId: context.userId,
        requestedByName: requester?.name ?? context.userId,
        actionType: input.actionType,
        actionStatus: "AGUARDANDO_APROVACAO",
        targetKind: "OPORTUNIDADE",
        targetId: opportunity.id,
        targetLabel: opportunity.contactName,
        suggestion: ACTION_LABELS[input.actionType],
        evidenceCodes: opportunity.evidence.map((e) => e.code),
        before: preview.before,
        after: preview.after,
        aiConfidence: opportunity.confidence,
        automationMode: settings.automationMode,
        success: false,
      });

      return ok(
        {
          status: "AGUARDANDO_APROVACAO",
          requiresConfirmation: true,
          reason: decision.reason,
          preview,
          canApprove: canApproveActions(context.role) || input.actionType !== "ATUALIZAR_VALOR",
        },
        { dataMode: overview.dataMode, pendingValidation: overview.pendingValidation },
      );
    }

    /* --- Execucao ---------------------------------------------------------- */
    const preview = await buildPreview({
      accountId: context.accountId,
      opportunity,
      actionType: input.actionType,
      overrides: input.overrides,
    });

    // Acoes puramente locais (nao tocam a API) podem ser efetivadas agora.
    const isLocalOnly =
      input.actionType === "MARCAR_ANALISADA" || input.actionType === "IGNORAR_RECOMENDACAO";

    const resultado: ResultadoDaExecucao = isLocalOnly
      ? {
          status: "EXECUTADA",
          apiResult: { ok: true, message: "Acao local, sem chamada a API." },
          notice: "Acao registrada localmente.",
        }
      : input.actionType === "APLICAR_ETIQUETAS"
        ? await aplicarEtiquetas({
            accountId: context.accountId,
            contactId: opportunity.contactId,
            contactName: opportunity.contactName,
            sugeridas: opportunity.suggestedAccountTags,
          })
        : {
            status: "SIMULADA",
            apiResult: {
              ok: false,
              message:
                "Escrita na API nao executada: contratos de escrita ainda pendentes de validacao.",
            },
            notice:
              "Esta acao foi apenas simulada. Nenhum dado foi alterado na KlipFlowi: " +
              "os contratos de escrita da API ainda precisam ser confirmados na documentacao.",
          };

    const entry = recordAudit({
      accountId: context.accountId,
      requestedByUserId: context.userId,
      requestedByName: requester?.name ?? context.userId,
      actionType: input.actionType,
      actionStatus:
        resultado.status === "EXECUTADA"
          ? "EXECUTADA"
          : resultado.status === "FALHOU"
            ? "FALHOU"
            : "APROVADA",
      targetKind: "OPORTUNIDADE",
      targetId: opportunity.id,
      targetLabel: opportunity.contactName,
      suggestion: ACTION_LABELS[input.actionType],
      evidenceCodes: opportunity.evidence.map((e) => e.code),
      before: preview.before,
      // Quando a acao mexeu de verdade, o "depois" da auditoria e o que a API
      // devolveu — nao o que pretendiamos fazer.
      after: resultado.depois ?? preview.after,
      aiConfidence: opportunity.confidence,
      automationMode: settings.automationMode,
      apiResult: resultado.apiResult,
      success: resultado.status === "EXECUTADA",
      approvedByUserId: input.confirmed ? context.userId : undefined,
      approvedByName: input.confirmed ? requester?.name : undefined,
    });

    return ok(
      {
        status: resultado.status,
        auditId: entry.id,
        preview,
        notice: resultado.notice,
      },
      { dataMode: overview.dataMode, pendingValidation: overview.pendingValidation },
    );
  } catch (error) {
    return handleError(error);
  }
}

/* ==========================================================================
   Previa do que a acao faria
   ========================================================================== */
interface ActionPreview {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  description: string;
  warnings: string[];
}

async function buildPreview(params: {
  accountId: string;
  opportunity: Awaited<ReturnType<typeof loadOverview>>["opportunities"][number];
  actionType: (typeof ACTION_TYPES)[number];
  overrides?: z.infer<typeof bodySchema>["overrides"];
}): Promise<ActionPreview> {
  const { opportunity, actionType, overrides } = params;
  const warnings: string[] = [];

  switch (actionType) {
    case "APLICAR_ETIQUETAS": {
      const sugeridas = opportunity.suggestedAccountTags;

      if (sugeridas.length === 0) {
        warnings.push(
          "Nenhuma etiqueta desta conta se aplica a esta conversa. Nada seria enviado.",
        );
      }

      /*
       * O "antes" e o estado REAL do contato.
       *
       * Enquanto a acao era simulada, um texto generico bastava. Agora que
       * ela escreve de verdade, quem confirma precisa ver o que ja esta la:
       * e a diferenca entre aprovar uma mudanca e aprovar uma promessa. Se a
       * consulta falhar, a previa continua — perder o "antes" nao pode
       * impedir a acao de ser avaliada.
       */
      const existing = await tagsAdapter.list({ accountId: params.accountId });
      const atuais = await contactsAdapter
        .getById({ accountId: params.accountId, contactId: opportunity.contactId })
        .then((r) => r.data?.tagIds ?? null)
        .catch(() => null);

      const nomePorId = new Map(existing.data.map((t) => [t.id, t.name]));

      return {
        before: {
          etiquetasAtuais:
            atuais === null
              ? "(nao foi possivel consultar o contato)"
              : atuais.map((id) => nomePorId.get(id) ?? id),
        },
        after: {
          // Cada sugestao vai com o motivo e o trecho: quem confirma julga a
          // evidencia, nao so o rotulo.
          etiquetasAAplicar: sugeridas.map((s) => ({
            nome: s.tagName,
            motivo: s.motivo,
            origem: s.origem,
            ...(s.trecho ? { trecho: s.trecho } : {}),
          })),
        },
        description:
          sugeridas.length === 0
            ? `Nenhuma etiqueta a aplicar em ${opportunity.contactName}.`
            : `Acrescentar ${sugeridas.length} etiqueta(s) ja existente(s) na conta ao ` +
              `contato ${opportunity.contactName}. As atuais permanecem.`,
        warnings,
      };
    }

    case "CRIAR_CARD":
      if (opportunity.cardId) {
        warnings.push(
          "Ja existe um card vinculado a este contato. Criar outro geraria duplicidade — " +
            "prefira atualizar o card existente.",
        );
      }
      return {
        before: null,
        after: {
          titulo: `${opportunity.company ?? opportunity.contactName} - ${opportunity.productInterest ?? "Oportunidade"}`,
          etapa: overrides?.stepName ?? opportunity.recommendedStepName,
          valor: overrides?.amount ?? opportunity.estimatedValue,
          contatoId: opportunity.contactId,
          atendimentoId: opportunity.sessionId,
        },
        description: `Criar card no funil para ${opportunity.contactName}.`,
        warnings,
      };

    case "ATUALIZAR_CARD":
    case "MOVER_ETAPA":
      if (!opportunity.cardId) {
        warnings.push("Nao ha card vinculado a esta oportunidade para atualizar.");
      }
      return {
        before: {
          etapaAtual: opportunity.currentStepName,
          valorAtual: opportunity.estimatedValue,
        },
        after: {
          etapaNova: overrides?.stepName ?? opportunity.recommendedStepName,
          valorNovo: overrides?.amount ?? opportunity.estimatedValue,
        },
        description:
          `Mover o card de "${opportunity.currentStepName ?? "sem etapa"}" para ` +
          `"${overrides?.stepName ?? opportunity.recommendedStepName ?? "etapa recomendada"}".`,
        warnings,
      };

    case "ATRIBUIR_RESPONSAVEL":
      return {
        before: { responsavelAtual: opportunity.agentName ?? "sem responsavel" },
        after: { responsavelNovo: overrides?.responsibleId ?? "(a definir)" },
        description: "Trocar o responsavel exige confirmacao humana em qualquer modo.",
        warnings,
      };

    case "ATUALIZAR_VALOR":
      if (opportunity.estimatedValueIsInferred) {
        warnings.push(
          "O valor atual foi INFERIDO pela IA a partir da conversa e nao foi confirmado " +
            "por uma pessoa. Revise antes de gravar.",
        );
      }
      return {
        before: { valorAtual: opportunity.estimatedValue },
        after: { valorNovo: overrides?.amount },
        description: "Alterar o valor financeiro da oportunidade.",
        warnings,
      };

    case "CRIAR_NOTA":
      return {
        before: null,
        after: {
          texto:
            overrides?.note ??
            `[Flowi IA] Score ${opportunity.score}/100 (confianca ${opportunity.confidence}%). ` +
              `${opportunity.reason} Proximo passo sugerido: ${opportunity.nextAction}`,
        },
        description: "Registrar a analise como nota interna.",
        warnings,
      };

    case "DEFINIR_FOLLOWUP":
      return {
        before: null,
        after: { dataFollowUp: overrides?.followUpDate ?? "(a definir)" },
        description: "Agendar a data do proximo contato.",
        warnings,
      };

    case "ENVIAR_MENSAGEM":
      warnings.push(
        "Envio de mensagem ao cliente NAO esta habilitado nesta entrega. " +
          "A mensagem abaixo e apenas uma sugestao para voce revisar e enviar manualmente.",
      );
      return {
        before: null,
        after: { mensagemSugerida: opportunity.suggestedFollowUpMessage },
        description: "Mensagem de follow-up sugerida.",
        warnings,
      };

    case "MARCAR_GANHA":
    case "MARCAR_PERDIDA":
      warnings.push(
        "Marcar ganho ou perda exige confirmacao humana e altera a previsao de vendas.",
      );
      return {
        before: { statusAtual: "OPEN" },
        after: { statusNovo: actionType === "MARCAR_GANHA" ? "WON" : "LOST" },
        description: "Alterar o status final da oportunidade.",
        warnings,
      };

    default:
      return {
        before: null,
        after: null,
        description: ACTION_LABELS[actionType],
        warnings,
      };
  }
}
