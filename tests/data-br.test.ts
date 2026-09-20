import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ehDataLegivel, interpretarData } from "@/server/import/data-br";

/**
 * Leitura de data vinda de planilha.
 *
 * Dois defeitos do `Date.parse` justificam este módulo inteiro, e os dois
 * foram medidos, não supostos:
 *
 *   `Date.parse("data inválida número 0")` devolve 1º de janeiro de 2000 —
 *   inventa uma data a partir de texto que não é data. Numa coluna mapeada
 *   por engano isso não dá erro: dá conversa reordenada com carimbo falso.
 *
 *   `Date.parse("16/09/2026")` devolve NaN — o formato brasileiro, que é
 *   justamente o que um relatório em português traz, não é reconhecido. Sem
 *   tratamento, a planilha inteira seria rejeitada linha a linha.
 */

/** Instante em ISO, para comparar sem depender do fuso do processo. */
function iso(bruto: string): string | null {
  const instante = interpretarData(bruto);
  return instante === null ? null : new Date(instante).toISOString();
}

describe("formatos que sabemos ler", () => {
  it("ISO com fuso declarado — o que o próprio .xlsx entrega", () => {
    assert.equal(iso("2026-09-16T18:25:43.000Z"), "2026-09-16T18:25:43.000Z");
    assert.equal(iso("2026-09-16T15:25:43-03:00"), "2026-09-16T18:25:43.000Z");
  });

  /**
   * O relatório é exportado por uma empresa brasileira e traz hora local. Ler
   * como UTC deslocaria tudo em três horas — pouco para a maioria das contas,
   * e o bastante para errar "sem resposta há X horas" na virada do dia.
   */
  it("data e hora sem fuso são lidas como horário de Brasília", () => {
    assert.equal(iso("2026-09-16 15:25:43"), "2026-09-16T18:25:43.000Z");
    assert.equal(iso("2026-09-16T15:25"), "2026-09-16T18:25:00.000Z");
  });

  it("formato brasileiro, que o Date.parse não entende", () => {
    assert.equal(iso("16/09/2026"), "2026-09-16T03:00:00.000Z");
    assert.equal(iso("16/09/2026 15:25"), "2026-09-16T18:25:00.000Z");
    assert.equal(iso("16/09/2026 15:25:43"), "2026-09-16T18:25:43.000Z");
    // Dia e mês com um dígito só, que é como muita planilha sai.
    assert.equal(iso("6/9/2026 15:25"), "2026-09-06T18:25:00.000Z");
  });

  it("data sozinha, no formato ISO", () => {
    assert.equal(iso("2026-09-16"), "2026-09-16T03:00:00.000Z");
  });

  /**
   * `03/04/2026` é ambíguo entre 3 de abril e 4 de março, e não há como
   * desfazer a ambiguidade linha a linha. Dia primeiro é a leitura certa para
   * um relatório em português — e uma escolha fixa erra de forma previsível,
   * enquanto uma heurística por linha erraria só em algumas, que é impossível
   * de perceber.
   */
  it("dia vem primeiro, sempre", () => {
    assert.equal(iso("03/04/2026")?.slice(0, 10), "2026-04-03");
  });
});

describe("o que é recusado", () => {
  /** O defeito que motivou o módulo. */
  it("não inventa data a partir de texto solto", () => {
    for (const lixo of [
      "data inválida número 0",
      "data inválida número 5",
      "ontem",
      "não é data",
      "mensagem de áudio",
      "Cristiano Silva",
    ]) {
      assert.equal(interpretarData(lixo), null, `não deveria virar data: ${lixo}`);
    }
  });

  it("número solto não é data", () => {
    // "5" vira ano 2005 em vários parsers, e uma coluna de quantidade viraria
    // a coluna de data.
    assert.equal(interpretarData("5"), null);
    assert.equal(interpretarData("45916"), null, "nem o serial cru do Excel");
    assert.equal(interpretarData("4500,50"), null);
  });

  /**
   * O `Date` rola 31 de fevereiro para 3 de março em silêncio. Uma data
   * rolada é pior que uma recusada: ninguém vê.
   */
  it("recusa data que não existe, em vez de rolar para o mês seguinte", () => {
    assert.equal(interpretarData("31/02/2026"), null);
    assert.equal(interpretarData("2026-02-31"), null);
    assert.equal(interpretarData("31/04/2026"), null, "abril tem 30 dias");
    assert.equal(interpretarData("29/02/2027"), null, "2027 não é bissexto");
    assert.ok(interpretarData("29/02/2028") !== null, "2028 é bissexto");
  });

  it("recusa mês, dia e hora fora da faixa", () => {
    assert.equal(interpretarData("16/13/2026"), null);
    assert.equal(interpretarData("00/09/2026"), null);
    assert.equal(interpretarData("16/09/2026 25:00"), null);
    assert.equal(interpretarData("16/09/2026 12:99"), null);
  });

  it("recusa vazio", () => {
    assert.equal(interpretarData(""), null);
    assert.equal(interpretarData("   "), null);
  });
});

describe("ehDataLegivel acompanha interpretarData", () => {
  /**
   * Se detecção e leitura divergissem, a coluna seria escolhida no mapeamento
   * e rejeitada linha a linha depois — o importador apontaria a coluna certa
   * e recusaria a planilha inteira.
   */
  it("concorda com interpretarData em todo caso testado", () => {
    const casos = [
      "2026-09-16T18:25:43.000Z",
      "16/09/2026 15:25",
      "2026-09-16",
      "ontem",
      "5",
      "31/02/2026",
      "",
    ];

    for (const caso of casos) {
      assert.equal(
        ehDataLegivel(caso),
        interpretarData(caso) !== null,
        `divergência em: ${caso}`,
      );
    }
  });
});
