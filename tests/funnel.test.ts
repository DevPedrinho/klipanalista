import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PanelStep } from "@/domain/types";
import {
  estagioSugerido,
  recomendarEtapa,
} from "@/server/services/opportunity.service";

/**
 * Recomendacao de etapa em funis com nomenclatura propria.
 *
 * Estes testes existem por causa de um defeito real: a versao anterior
 * procurava os fragmentos "qualifica", "proposta" e "negocia" no nome da
 * etapa e devolvia `undefined` quando nenhum casava. Em um funil como
 * "Proposta Quente / Visita / Stand By / Ordem de Compra / Entregue", a
 * oportunidade MAIS quente era justamente a que ficava sem recomendacao.
 */

function etapa(
  name: string,
  order: number,
  extra: Partial<PanelStep> = {},
): PanelStep {
  return { id: `step_${order}`, name, order, ...extra };
}

/** Funil real de um cliente KlipFlowi (materiais de construcao). */
const FUNIL_REAL: PanelStep[] = [
  etapa("Proposta Quente", 1, { isTriage: true }),
  etapa("Visita", 2),
  etapa("Stand By", 3),
  etapa("Ordem de Compra", 4),
  etapa("Entregue", 5, { phase: "FINAL" }),
];

/** Funil com a nomenclatura classica de CRM. */
const FUNIL_CLASSICO: PanelStep[] = [
  etapa("Novos leads", 1, { phase: "INITIAL", isTriage: true }),
  etapa("Qualificacao", 2),
  etapa("Proposta enviada", 3),
  etapa("Negociacao", 4),
  etapa("Ganho", 5, { phase: "FINAL" }),
  etapa("Perdido", 6, { phase: "FINAL" }),
];

/**
 * Funil que nomeia as etapas FORA da ordem comercial esperada.
 *
 * Nao e hipotese de laboratorio: acontece quando a empresa reaproveita nomes
 * ("Negociacao" como triagem de quem ja veio indicado) ou quando alguem
 * reordena o painel sem renomear. Sem este caso, o teste de monotonicidade
 * passa mesmo com o piso removido — foi o que uma sabotagem deliberada
 * mostrou.
 */
const FUNIL_FORA_DE_ORDEM: PanelStep[] = [
  etapa("Negociacao", 1),
  etapa("Proposta", 2),
  etapa("Qualificacao", 3),
];

/** Funil sem nenhuma palavra reconhecivel. */
const FUNIL_OPACO: PanelStep[] = [
  etapa("Fase A", 1),
  etapa("Fase B", 2),
  etapa("Fase C", 3),
  etapa("Fase D", 4),
];

describe("estagioSugerido", () => {
  it("leva a NEGOCIACAO quando ha desconto pedido ou orcamento aprovado", () => {
    assert.equal(estagioSugerido({ signalCodes: ["PEDIDO_DESCONTO"], score: 40 }), "NEGOCIACAO");
    assert.equal(estagioSugerido({ signalCodes: ["ORCAMENTO_APROVADO"], score: 20 }), "NEGOCIACAO");
  });

  it("leva a PROPOSTA quando o cliente pede preco ou manda especificacao", () => {
    assert.equal(estagioSugerido({ signalCodes: ["SOLICITACAO_PRECO"], score: 40 }), "PROPOSTA");
    assert.equal(estagioSugerido({ signalCodes: ["ENVIOU_ESPECIFICACAO"], score: 40 }), "PROPOSTA");
    assert.equal(estagioSugerido({ signalCodes: ["PROPOSTA_ENVIADA"], score: 40 }), "PROPOSTA");
  });

  it("usa o score apenas quando nao ha sinal especifico", () => {
    assert.equal(estagioSugerido({ signalCodes: [], score: 60 }), "QUALIFICACAO");
    assert.equal(estagioSugerido({ signalCodes: [], score: 10 }), "TRIAGEM");
  });
});

describe("recomendarEtapa — o defeito que motivou esta funcao", () => {
  it("SEMPRE recomenda alguma etapa aberta, em qualquer um dos estagios", () => {
    for (const steps of [FUNIL_REAL, FUNIL_CLASSICO, FUNIL_OPACO, FUNIL_FORA_DE_ORDEM]) {
      for (const estagio of ["TRIAGEM", "QUALIFICACAO", "PROPOSTA", "NEGOCIACAO"] as const) {
        const escolhida = recomendarEtapa({ steps, estagio });
        assert.ok(
          escolhida,
          `funil ${steps[0]?.name} ficou sem recomendacao no estagio ${estagio}`,
        );
        assert.ok(
          steps.some((s) => s.id === escolhida.id),
          "a etapa recomendada precisa existir no funil",
        );
      }
    }
  });

  it("nunca recomenda uma etapa de desfecho (ganho/perda)", () => {
    for (const steps of [FUNIL_REAL, FUNIL_CLASSICO]) {
      for (const estagio of ["TRIAGEM", "QUALIFICACAO", "PROPOSTA", "NEGOCIACAO"] as const) {
        const escolhida = recomendarEtapa({ steps, estagio });
        assert.notEqual(
          escolhida?.phase,
          "FINAL",
          `marcar ganho/perda e decisao de pessoa, nunca da leitura da conversa (${estagio})`,
        );
      }
    }
  });

  it("reconhece 'Ordem de Compra' como etapa de negociacao", () => {
    const escolhida = recomendarEtapa({ steps: FUNIL_REAL, estagio: "NEGOCIACAO" });
    assert.equal(escolhida?.name, "Ordem de Compra");
  });

  it("reconhece 'Visita' e 'Proposta Quente' como etapas de proposta", () => {
    const escolhida = recomendarEtapa({ steps: FUNIL_REAL, estagio: "PROPOSTA" });
    assert.ok(
      escolhida?.name === "Proposta Quente" || escolhida?.name === "Visita",
      `esperava uma etapa de proposta, veio "${escolhida?.name}"`,
    );
  });

  it("nunca recomenda 'Stand By': espera nao e avanco de funil", () => {
    for (const estagio of ["TRIAGEM", "QUALIFICACAO", "PROPOSTA", "NEGOCIACAO"] as const) {
      const escolhida = recomendarEtapa({ steps: FUNIL_REAL, estagio });
      assert.notEqual(escolhida?.name, "Stand By", `estagio ${estagio} caiu em Stand By`);
    }
  });

  it("acerta o funil classico em cada estagio", () => {
    assert.equal(recomendarEtapa({ steps: FUNIL_CLASSICO, estagio: "TRIAGEM" })?.name, "Novos leads");
    assert.equal(
      recomendarEtapa({ steps: FUNIL_CLASSICO, estagio: "QUALIFICACAO" })?.name,
      "Qualificacao",
    );
    assert.equal(
      recomendarEtapa({ steps: FUNIL_CLASSICO, estagio: "PROPOSTA" })?.name,
      "Proposta enviada",
    );
    assert.equal(
      recomendarEtapa({ steps: FUNIL_CLASSICO, estagio: "NEGOCIACAO" })?.name,
      "Negociacao",
    );
  });

  it("usa a posicao no funil quando nenhum nome e reconhecivel", () => {
    assert.equal(recomendarEtapa({ steps: FUNIL_OPACO, estagio: "TRIAGEM" })?.name, "Fase A");
    assert.equal(recomendarEtapa({ steps: FUNIL_OPACO, estagio: "NEGOCIACAO" })?.name, "Fase D");
  });

  it("avanca de forma monotona: estagio mais quente nunca recua no funil", () => {
    for (const steps of [FUNIL_REAL, FUNIL_CLASSICO, FUNIL_OPACO, FUNIL_FORA_DE_ORDEM]) {
      const ordens = (["TRIAGEM", "QUALIFICACAO", "PROPOSTA", "NEGOCIACAO"] as const).map(
        (estagio) => recomendarEtapa({ steps, estagio })?.order ?? -1,
      );

      for (let i = 1; i < ordens.length; i += 1) {
        assert.ok(
          (ordens[i] ?? -1) >= (ordens[i - 1] ?? -1),
          `estagio mais quente recuou no funil ${steps[0]?.name}: ${ordens.join(" -> ")}`,
        );
      }
    }
  });

  it("devolve undefined so quando o funil nao tem etapa aberta alguma", () => {
    const somenteDesfecho: PanelStep[] = [
      etapa("Ganho", 1, { phase: "FINAL" }),
      etapa("Perdido", 2, { phase: "FINAL" }),
    ];
    assert.equal(recomendarEtapa({ steps: somenteDesfecho, estagio: "PROPOSTA" }), undefined);
    assert.equal(recomendarEtapa({ steps: [], estagio: "TRIAGEM" }), undefined);
  });
});

describe("recomendarEtapa — vocabulario configuravel por conta", () => {
  it("respeita FLW_FUNNEL_NEGOCIACAO quando a conta tem nomenclatura propria", () => {
    const anterior = process.env["FLW_FUNNEL_NEGOCIACAO"];
    process.env["FLW_FUNNEL_NEGOCIACAO"] = "fase c";

    try {
      assert.equal(
        recomendarEtapa({ steps: FUNIL_OPACO, estagio: "NEGOCIACAO" })?.name,
        "Fase C",
      );
    } finally {
      if (anterior === undefined) delete process.env["FLW_FUNNEL_NEGOCIACAO"];
      else process.env["FLW_FUNNEL_NEGOCIACAO"] = anterior;
    }
  });
});
