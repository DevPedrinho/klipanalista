import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emParalelo } from "@/server/services/intelligence.service";

/**
 * A fila de leitura da IA.
 *
 * O que ela substituiu foram levas de tamanho fixo com uma checagem de
 * relógio na fronteira. Contra a conta real isso custou caro: a primeira leva
 * de 20 conversas levou 23 segundos, o prazo venceu na fronteira seguinte e
 * 40 conversas ficaram sem análise — com 19 dos 20 trabalhadores ociosos há
 * segundos, porque a leva inteira espera pela conversa mais lenta.
 *
 * Os testes abaixo fixam as três propriedades que sustentam a troca.
 */
describe("fila paralela com prazo", () => {
  const nunca = () => Date.now() + 60_000;

  it("processa todos os itens quando ha tempo", async () => {
    const itens = [1, 2, 3, 4, 5, 6, 7];

    const { resultados, naoIniciados } = await emParalelo(
      itens,
      3,
      nunca(),
      async (n) => n * 2,
    );

    assert.equal(naoIniciados, 0);
    assert.equal(resultados.length, itens.length);

    const valores = resultados
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<number>).value)
      .sort((a, b) => a - b);

    assert.deepEqual(valores, [2, 4, 6, 8, 10, 12, 14]);
  });

  it("nao deixa um item lento decidir o destino dos que nem comecaram", async () => {
    // Prazo ja vencido: nenhum item deve ser iniciado, e o total precisa
    // aparecer em `naoIniciados` em vez de sumir da contagem.
    let executados = 0;

    const { resultados, naoIniciados } = await emParalelo(
      [1, 2, 3, 4, 5],
      2,
      Date.now() - 1,
      async (n) => {
        executados += 1;
        return n;
      },
    );

    assert.equal(executados, 0, "nada deveria rodar com o prazo vencido");
    assert.equal(resultados.length, 0);
    assert.equal(naoIniciados, 5, "o que ficou de fora precisa ser contado");
  });

  it("um item que falha nao derruba os demais", async () => {
    const { resultados, naoIniciados } = await emParalelo(
      [1, 2, 3, 4],
      2,
      nunca(),
      async (n) => {
        if (n === 2) throw new Error("conversa ilegivel");
        return n;
      },
    );

    assert.equal(naoIniciados, 0);
    assert.equal(resultados.length, 4);
    assert.equal(resultados.filter((r) => r.status === "rejected").length, 1);
    assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 3);
  });

  it("respeita o limite de trabalhadores simultaneos", async () => {
    let emVoo = 0;
    let pico = 0;

    await emParalelo([...Array(12).keys()], 4, nunca(), async () => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      await new Promise((r) => setTimeout(r, 5));
      emVoo -= 1;
    });

    assert.ok(pico <= 4, `pico de ${pico} passou do limite de 4`);
    assert.ok(pico > 1, "sem paralelismo a fila nao serve para nada");
  });
});
