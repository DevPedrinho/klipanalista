import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extrairValoresDitos } from "@/server/services/opportunity.service";

/**
 * Valores em dinheiro ditos na conversa.
 *
 * As frases abaixo são literais da conta real — transcrições de áudio do
 * atendimento do Cristiano. Boa parte desta conta negocia por áudio, e a
 * versão anterior só entendia `R$ 1.234`. Como ninguém fala "erre cifrão", o
 * cliente dizia o orçamento com todas as letras e o módulo lia `undefined`:
 * o valor potencial do painel ficava zerado e a etiqueta de faixa nunca era
 * sugerida.
 */
describe("valores ditos na conversa", () => {
  it("entende o orçamento falado em áudio", () => {
    const frase =
      "Então em torno de 4 mil a 5 mil reais aí para um investimento primário, né? " +
      "Para o começo da minha máquina.";

    assert.deepEqual(extrairValoresDitos(frase), [4000, 5000]);
  });

  it("entende o teto repetido no fim da mesma mensagem", () => {
    const frase = "Aí no máximo em torno de 5 mil reais.";
    assert.deepEqual(extrairValoresDitos(frase), [5000]);
  });

  it("continua entendendo o formato com cifrão", () => {
    assert.deepEqual(extrairValoresDitos("fica R$ 4.500,00 à vista"), [4500]);
    assert.deepEqual(extrairValoresDitos("fica R$ 4500 à vista"), [4500]);
  });

  it("entende reais sem cifrão e a abreviação k", () => {
    assert.deepEqual(extrairValoresDitos("custa 150 reais"), [150]);
    assert.deepEqual(extrairValoresDitos("uns 1.200 reais"), [1200]);
    assert.deepEqual(extrairValoresDitos("por 7k fechado"), [7000]);
    assert.deepEqual(extrairValoresDitos("4,5 mil no pix"), [4500]);
  });

  /**
   * A parte que impede a regra de virar ruído. Todas as frases abaixo são
   * literais da mesma conversa, e nenhuma delas é dinheiro.
   */
  describe("não confunde número com dinheiro", () => {
    const naoSaoValores = [
      "Essa compra vai ficar para o começo do mês, talvez lá para o dia 5, dia 10",
      "ou então aquela X70E da Arus, né? A Arus Master",
      "Rua Ecilda de Queiroz, 200, Loja 17",
      "Segunda a Sábado, 09h às 18h30",
      "Eu estou olhando aqui as placas ATX, aquelas placas mini ATX",
      "tipo um layout de umas três máquinas com preços diferenciados",
    ];

    for (const frase of naoSaoValores) {
      it(`ignora: ${frase.slice(0, 42)}...`, () => {
        assert.deepEqual(extrairValoresDitos(frase), []);
      });
    }
  });

  it("descarta centavo solto e texto sem número", () => {
    assert.deepEqual(extrairValoresDitos("sem valor nenhum aqui"), []);
    assert.deepEqual(extrairValoresDitos("R$ 0"), []);
  });
});
