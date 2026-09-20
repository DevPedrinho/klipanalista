import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analisarConjunto } from "@/server/services/intelligence.service";
import { defaultSettings } from "@/server/services/automation.service";
import { resolvePeriod } from "@/server/security/tenant-context";
import {
  MOCK_CARDS,
  MOCK_CONTACTS,
  MOCK_CONVERSATIONS,
  MOCK_PANELS,
  MOCK_TAGS,
  MOCK_USERS,
} from "@/mocks/dataset";
import type { TenantContext } from "@/domain/types";

/**
 * O motor de análise, alimentado à mão.
 *
 * Até aqui a única forma de rodar a análise era `loadOverview`, que sempre
 * chamava os adapters. Isso amarrava o motor à API: uma segunda fonte de
 * conversas — a planilha exportada da KlipFlowi — teria que ganhar uma cópia
 * de score, detecção de sinais, verificação de evidência, funil, qualidade e
 * indicadores. Seis coisas que não podem divergir entre as duas entradas.
 *
 * Estes testes chamam `analisarConjunto` com os dados na mão, sem adapter
 * nenhum. Se um dia alguém voltar a acoplar o motor à busca, eles quebram.
 */

const CONTA = "acc_klipflowi_demo";

const contexto: TenantContext = {
  accountId: CONTA,
  userId: "user_elaine",
  role: "ADMIN",
  visibleAgentIds: "ALL",
};

/** Período largo o bastante para conter o dataset simulado inteiro. */
const filtros = { period: resolvePeriod({ preset: "90d" }) };

function dados(over: Partial<Parameters<typeof analisarConjunto>[0]["dados"]> = {}) {
  return {
    conversations: MOCK_CONVERSATIONS.filter((c) => c.accountId === CONTA),
    contacts: MOCK_CONTACTS.filter((c) => c.accountId === CONTA),
    cards: MOCK_CARDS,
    panels: MOCK_PANELS.filter((p) => p.accountId === CONTA),
    users: MOCK_USERS.filter((u) => u.accountId === CONTA),
    tags: MOCK_TAGS.filter((t) => t.accountId === CONTA),
    settings: defaultSettings(CONTA),
    ...over,
  };
}

describe("motor de análise alimentado sem a API", () => {
  it("produz oportunidades a partir de conversas entregues na mão", async () => {
    const overview = await analisarConjunto({
      dados: dados(),
      context: contexto,
      filters: filtros,
      semIa: true,
    });

    assert.ok(
      overview.opportunities.length > 0,
      "sem oportunidade não há motor para testar",
    );

    for (const oportunidade of overview.opportunities) {
      assert.ok(oportunidade.score >= 30, "o corte de score continua valendo");
      assert.ok(oportunidade.reason.length > 0, "toda oportunidade explica por quê");
    }
  });

  it("monta funil, qualidade e indicadores no mesmo passo", async () => {
    const overview = await analisarConjunto({
      dados: dados(),
      context: contexto,
      filters: filtros,
      semIa: true,
    });

    assert.ok(overview.funnels.length > 0, "o funil sai dos painéis e cards");
    assert.ok(overview.qualityReports.length > 0, "o relatório de qualidade sai das conversas");
    assert.equal(
      overview.kpis.oportunidadesEncontradas,
      overview.opportunities.length,
      "o indicador precisa contar o que está na tela",
    );
  });

  /**
   * O caso da planilha: quem exportou já escolheu o recorte, então não há
   * "conversas que ficaram de fora" para reportar.
   */
  it("sem estado de coleta, assume que o que chegou é tudo que havia", async () => {
    const entrada = dados();

    const overview = await analisarConjunto({
      dados: entrada,
      context: contexto,
      filters: filtros,
      semIa: true,
    });

    assert.equal(overview.coverage.conversasNoPeriodo, entrada.conversations.length);
    assert.equal(overview.coverage.truncado, false, "nada ficou de fora");
    assert.equal(overview.coverage.interrompidaPorTempo, false);
  });

  /**
   * O contrário: quem carregou sabe coisas que o motor não deduz. Se a busca
   * viu 547 conversas e só coube 60, dizer "60" como se fossem todas é a
   * diferença entre meia resposta honesta e uma resposta errada.
   */
  it("preserva o que a fase de busca descobriu sobre a própria busca", async () => {
    const overview = await analisarConjunto({
      dados: dados(),
      context: contexto,
      filters: filtros,
      semIa: true,
      coleta: {
        coverage: {
          conversasNoPeriodo: 547,
          conversasAnalisadas: 60,
          teto: 60,
          truncado: true,
          interrompidaPorTempo: false,
          tempos: { snapshots: 1630 },
        },
        sourceFailures: [
          { source: "Painéis do CRM", kind: "NAO_ENCONTRADO", message: "404" },
        ],
        pending: ["aviso vindo da busca"],
      },
    });

    assert.equal(overview.coverage.conversasNoPeriodo, 547);
    assert.equal(overview.coverage.truncado, true);
    assert.equal(overview.coverage.tempos["snapshots"], 1630);
    assert.ok(
      overview.sourceFailures.some((f) => f.source === "Painéis do CRM"),
      "a falha da busca precisa chegar à tela",
    );
    assert.ok(overview.pendingValidation.includes("aviso vindo da busca"));
  });

  it("não quebra quando só há conversas, sem cadastro nenhum", async () => {
    // É o pior caso da planilha: uma exportação que traz conversa e mais nada.
    const overview = await analisarConjunto({
      dados: dados({ cards: [], panels: [], tags: [], contacts: [] }),
      context: contexto,
      filters: filtros,
      semIa: true,
    });

    assert.deepEqual(overview.funnels, [], "sem painel não se inventa funil");
    for (const oportunidade of overview.opportunities) {
      assert.deepEqual(
        oportunidade.suggestedAccountTags,
        [],
        "sem etiqueta na conta não se sugere etiqueta",
      );
    }
  });
});
