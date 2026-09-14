import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTION_TYPES, type ActionType, type AutomationMode } from "@/domain/enums";
import type { IntegrationSettings } from "@/domain/types";
import {
  ALWAYS_CONFIRM,
  LOW_RISK_ACTIONS,
  decideAction,
  defaultSettings,
  requiresHumanConfirmation,
} from "@/server/services/automation.service";
import { clearSettings, getSettings, updateSettings } from "@/server/services/settings.service";

/**
 * Testes das travas de automacao.
 *
 * Esta e a parte do sistema em que um bug causa dano real ao cliente final:
 * uma mensagem enviada sem revisao, um negocio marcado como perdido por
 * engano, um valor financeiro sobrescrito. As regras abaixo nao podem
 * regredir em hipotese alguma.
 */

function settingsWith(
  mode: AutomationMode,
  allowed: ActionType[] = [...LOW_RISK_ACTIONS],
): IntegrationSettings {
  return {
    ...defaultSettings("acc1"),
    automationMode: mode,
    guardrails: {
      allowedAutoActions: allowed,
      alwaysRequireConfirmation: [...ALWAYS_CONFIRM],
    },
  };
}

describe("modo padrao do produto", () => {
  it("e Copiloto", () => {
    assert.equal(defaultSettings("acc1").automationMode, "COPILOTO");
  });
});

/* ==========================================================================
   Trava absoluta
   ========================================================================== */
describe("acoes que sempre exigem confirmacao humana", () => {
  const modos: AutomationMode[] = ["OBSERVADOR", "COPILOTO", "AUTOMATICO_CONTROLADO"];

  for (const acao of ALWAYS_CONFIRM) {
    for (const modo of modos) {
      it(`${acao} nunca executa sozinha no modo ${modo}`, () => {
        // Tenta o pior caso: a acao sensivel explicitamente na lista de
        // automacao, com o usuario mais privilegiado possivel.
        const settings = settingsWith(modo, [...LOW_RISK_ACTIONS, acao]);
        const decisao = decideAction({ actionType: acao, settings, role: "ADMIN" });

        assert.notEqual(
          decisao.outcome,
          "EXECUTAR_AUTOMATICO",
          `${acao} jamais pode executar automaticamente`,
        );
      });
    }
  }

  it("cobre todas as acoes sensiveis descritas no produto", () => {
    const esperadas: ActionType[] = [
      "ENVIAR_MENSAGEM",
      "MARCAR_GANHA",
      "MARCAR_PERDIDA",
      "ATUALIZAR_VALOR",
      "ATRIBUIR_RESPONSAVEL",
      "EXCLUIR_DADOS",
      "ARQUIVAR",
    ];
    for (const acao of esperadas) {
      assert.ok(ALWAYS_CONFIRM.includes(acao), `${acao} deveria exigir confirmacao`);
    }
  });
});

/* ==========================================================================
   Comportamento por modo
   ========================================================================== */
describe("modo Observador", () => {
  it("bloqueia qualquer alteracao", () => {
    for (const acao of LOW_RISK_ACTIONS) {
      const decisao = decideAction({
        actionType: acao,
        settings: settingsWith("OBSERVADOR"),
        role: "ADMIN",
      });
      assert.equal(decisao.outcome, "BLOQUEADA", `${acao} deveria ser bloqueada`);
    }
  });

  it("explica como destravar", () => {
    const decisao = decideAction({
      actionType: "CRIAR_CARD",
      settings: settingsWith("OBSERVADOR"),
      role: "ADMIN",
    });
    assert.match(decisao.reason, /copiloto/i);
  });
});

describe("modo Copiloto", () => {
  it("prepara mas exige confirmacao para tudo", () => {
    for (const acao of ACTION_TYPES) {
      const decisao = decideAction({
        actionType: acao,
        settings: settingsWith("COPILOTO"),
        role: "GESTOR",
      });
      assert.notEqual(
        decisao.outcome,
        "EXECUTAR_AUTOMATICO",
        `${acao} nao pode executar sozinha no Copiloto`,
      );
    }
  });
});

describe("modo Automatico controlado", () => {
  it("executa acoes de baixo risco autorizadas", () => {
    const decisao = decideAction({
      actionType: "APLICAR_ETIQUETAS",
      settings: settingsWith("AUTOMATICO_CONTROLADO", ["APLICAR_ETIQUETAS"]),
      role: "VENDEDOR",
    });
    assert.equal(decisao.outcome, "EXECUTAR_AUTOMATICO");
  });

  it("exige confirmacao para acao de baixo risco NAO autorizada", () => {
    const decisao = decideAction({
      actionType: "CRIAR_CARD",
      settings: settingsWith("AUTOMATICO_CONTROLADO", ["APLICAR_ETIQUETAS"]),
      role: "ADMIN",
    });
    assert.equal(decisao.outcome, "EXIGE_CONFIRMACAO");
  });

  it("nao considera de baixo risco nada que fale com o cliente", () => {
    assert.ok(
      !LOW_RISK_ACTIONS.includes("ENVIAR_MENSAGEM"),
      "enviar mensagem jamais e acao de baixo risco",
    );
  });
});

/* ==========================================================================
   Permissoes
   ========================================================================== */
describe("permissoes por perfil", () => {
  it("bloqueia exclusao de dados para nao-administradores", () => {
    for (const role of ["VENDEDOR", "GESTOR"] as const) {
      const decisao = decideAction({
        actionType: "EXCLUIR_DADOS",
        settings: settingsWith("COPILOTO"),
        role,
      });
      assert.notEqual(decisao.outcome, "EXECUTAR_AUTOMATICO");
    }
  });
});

/* ==========================================================================
   requiresHumanConfirmation
   ========================================================================== */
describe("requiresHumanConfirmation", () => {
  it("e verdadeiro para toda acao sensivel, em qualquer modo", () => {
    for (const acao of ALWAYS_CONFIRM) {
      for (const modo of ["OBSERVADOR", "COPILOTO", "AUTOMATICO_CONTROLADO"] as const) {
        assert.equal(
          requiresHumanConfirmation(acao, settingsWith(modo, [...ACTION_TYPES])),
          true,
          `${acao} em ${modo}`,
        );
      }
    }
  });
});

/* ==========================================================================
   A configuracao nao pode afrouxar a trava
   ========================================================================== */
describe("updateSettings", () => {
  it("descarta acoes sensiveis enviadas como automaticas", () => {
    clearSettings();

    const resultado = updateSettings({
      accountId: "acc_teste",
      updatedByUserId: "admin",
      automationMode: "AUTOMATICO_CONTROLADO",
      // Um administrador tentando autorizar o que nao pode ser autorizado.
      allowedAutoActions: [...ACTION_TYPES],
    });

    for (const acao of ALWAYS_CONFIRM) {
      assert.ok(
        !resultado.guardrails.allowedAutoActions.includes(acao),
        `${acao} nao pode entrar na lista de automacao`,
      );
    }
    // Sobra apenas o subconjunto reconhecido como de baixo risco.
    for (const acao of resultado.guardrails.allowedAutoActions) {
      assert.ok(LOW_RISK_ACTIONS.includes(acao), `${acao} nao e de baixo risco`);
    }
  });

  it("mantem a lista de confirmacao obrigatoria intacta", () => {
    clearSettings();
    const resultado = updateSettings({
      accountId: "acc_teste",
      updatedByUserId: "admin",
      allowedAutoActions: [],
    });
    assert.deepEqual(
      [...resultado.guardrails.alwaysRequireConfirmation].sort(),
      [...ALWAYS_CONFIRM].sort(),
    );
  });

  it("limita a retencao de dados a faixa permitida", () => {
    clearSettings();

    const curta = updateSettings({
      accountId: "acc_a", updatedByUserId: "admin", dataRetentionDays: 1,
    });
    assert.equal(curta.dataRetentionDays, 30);

    const longa = updateSettings({
      accountId: "acc_b", updatedByUserId: "admin", dataRetentionDays: 99999,
    });
    assert.equal(longa.dataRetentionDays, 1095);
  });

  it("mantem o uso para treinamento desligado por padrao", () => {
    clearSettings();
    assert.equal(getSettings("acc_novo").allowTrainingUsage, false);
  });

  it("isola as configuracoes entre contas", () => {
    clearSettings();

    updateSettings({
      accountId: "acc_x", updatedByUserId: "admin", automationMode: "AUTOMATICO_CONTROLADO",
    });

    assert.equal(getSettings("acc_x").automationMode, "AUTOMATICO_CONTROLADO");
    assert.equal(
      getSettings("acc_y").automationMode,
      "COPILOTO",
      "outra conta nao pode herdar a configuracao",
    );
  });
});
