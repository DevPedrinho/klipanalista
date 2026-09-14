import "server-only";
import {
  DEFAULT_AUTOMATION_MODE,
  type ActionType,
  type AutomationMode,
  type UserRole,
} from "@/domain/enums";
import type { AutomationGuardrails, IntegrationSettings } from "@/domain/types";

/**
 * Modos de automacao e suas travas.
 *
 * OBSERVADOR            -> a IA analisa e recomenda. Nao altera nada.
 * COPILOTO (padrao)     -> a IA prepara a mudanca; um humano confirma.
 * AUTOMATICO_CONTROLADO -> a IA executa acoes de baixo risco previamente
 *                          autorizadas, e so essas.
 */

/**
 * Acoes que exigem confirmacao humana em QUALQUER modo, inclusive no
 * automatico. Esta lista e a ultima linha de defesa do produto e nao pode
 * ser afrouxada por configuracao.
 */
export const ALWAYS_CONFIRM: readonly ActionType[] = [
  "ENVIAR_MENSAGEM",
  "MARCAR_GANHA",
  "MARCAR_PERDIDA",
  "ATUALIZAR_VALOR",
  "ATRIBUIR_RESPONSAVEL",
  "EXCLUIR_DADOS",
  "ARQUIVAR",
] as const;

/** Acoes de baixo risco liberaveis no modo automatico controlado. */
export const LOW_RISK_ACTIONS: readonly ActionType[] = [
  "APLICAR_ETIQUETAS",
  "CRIAR_NOTA",
  "CRIAR_CARD",
  "DEFINIR_FOLLOWUP",
  "MARCAR_ANALISADA",
] as const;

export const DEFAULT_GUARDRAILS: AutomationGuardrails = {
  allowedAutoActions: [...LOW_RISK_ACTIONS],
  alwaysRequireConfirmation: [...ALWAYS_CONFIRM],
};

export function defaultSettings(accountId: string): IntegrationSettings {
  return {
    accountId,
    automationMode: DEFAULT_AUTOMATION_MODE,
    guardrails: DEFAULT_GUARDRAILS,
    dataRetentionDays: 180,
    allowTrainingUsage: false,
    updatedAt: new Date().toISOString(),
  };
}

export type Decision =
  | { outcome: "EXECUTAR_AUTOMATICO"; reason: string }
  | { outcome: "EXIGE_CONFIRMACAO"; reason: string }
  | { outcome: "BLOQUEADA"; reason: string };

/**
 * Decide o que pode acontecer com uma acao, considerando modo, guardrails
 * e perfil de quem pediu.
 *
 * A ordem das verificacoes importa: a lista `ALWAYS_CONFIRM` e avaliada
 * ANTES do modo, para que nenhuma configuracao possa liberar o que o
 * produto define como sempre-confirmar.
 */
export function decideAction(params: {
  actionType: ActionType;
  settings: IntegrationSettings;
  role: UserRole;
}): Decision {
  const { actionType, settings, role } = params;

  // 1. Trava absoluta, independente de modo e de configuracao.
  if (ALWAYS_CONFIRM.includes(actionType)) {
    return {
      outcome: "EXIGE_CONFIRMACAO",
      reason:
        "Esta acao altera dados sensiveis ou fala com o cliente. Exige " +
        "confirmacao humana em todos os modos de automacao.",
    };
  }

  // 2. Acoes destrutivas exigem perfil administrativo.
  if (actionType === "EXCLUIR_DADOS" && role !== "ADMIN") {
    return {
      outcome: "BLOQUEADA",
      reason: "Apenas administradores podem solicitar exclusao de dados.",
    };
  }

  // 3. Modo de automacao.
  switch (settings.automationMode) {
    case "OBSERVADOR":
      return {
        outcome: "BLOQUEADA",
        reason:
          "Modo Observador: a Flowi IA apenas analisa e recomenda. " +
          "Troque para Copiloto para aplicar as sugestoes.",
      };

    case "COPILOTO":
      return {
        outcome: "EXIGE_CONFIRMACAO",
        reason: "Modo Copiloto: a IA preparou a mudanca. Confirme para aplicar.",
      };

    case "AUTOMATICO_CONTROLADO": {
      const allowed = settings.guardrails.allowedAutoActions.includes(actionType);
      if (!allowed) {
        return {
          outcome: "EXIGE_CONFIRMACAO",
          reason:
            "Modo Automatico controlado: esta acao nao esta na lista de acoes " +
            "de baixo risco autorizadas. Confirme manualmente ou autorize-a nas " +
            "configuracoes.",
        };
      }
      return {
        outcome: "EXECUTAR_AUTOMATICO",
        reason: "Acao de baixo risco previamente autorizada neste modo.",
      };
    }
  }
}

/** true quando a acao precisa de confirmacao humana antes de qualquer efeito. */
export function requiresHumanConfirmation(
  actionType: ActionType,
  settings: IntegrationSettings,
): boolean {
  if (ALWAYS_CONFIRM.includes(actionType)) return true;
  if (settings.automationMode === "AUTOMATICO_CONTROLADO") {
    return !settings.guardrails.allowedAutoActions.includes(actionType);
  }
  return true;
}

export const MODE_LABELS: Record<AutomationMode, { title: string; description: string }> = {
  OBSERVADOR: {
    title: "Observador",
    description:
      "A Flowi IA apenas analisa os atendimentos e recomenda. Nenhuma informacao " +
      "e alterada na plataforma.",
  },
  COPILOTO: {
    title: "Copiloto",
    description:
      "A IA prepara as mudancas e mostra exatamente o que sera alterado. O vendedor " +
      "ou gestor confirma antes de aplicar. Modo padrao.",
  },
  AUTOMATICO_CONTROLADO: {
    title: "Automatico controlado",
    description:
      "A IA executa sozinha apenas acoes de baixo risco previamente autorizadas. " +
      "Mensagens ao cliente, valores e status de ganho/perda continuam exigindo " +
      "confirmacao humana.",
  },
};

export const ACTION_LABELS: Record<ActionType, string> = {
  CRIAR_CARD: "Criar oportunidade no CRM",
  ATUALIZAR_CARD: "Atualizar card existente",
  MOVER_ETAPA: "Mover para outra etapa",
  APLICAR_ETIQUETAS: "Aplicar etiquetas",
  REMOVER_ETIQUETAS: "Remover etiquetas",
  ATRIBUIR_RESPONSAVEL: "Atribuir responsavel",
  ATUALIZAR_VALOR: "Atualizar valor da oportunidade",
  CRIAR_NOTA: "Criar nota interna",
  DEFINIR_FOLLOWUP: "Definir data de follow-up",
  MARCAR_ANALISADA: "Marcar como analisada",
  IGNORAR_RECOMENDACAO: "Ignorar recomendacao",
  ENVIAR_MENSAGEM: "Enviar mensagem ao cliente",
  MARCAR_GANHA: "Marcar oportunidade como ganha",
  MARCAR_PERDIDA: "Marcar oportunidade como perdida",
  ARQUIVAR: "Arquivar contato ou card",
  EXCLUIR_DADOS: "Excluir dados",
};
