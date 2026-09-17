import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lerFaixasDeValor,
  sugerirEtiquetasDaConta,
} from "@/server/services/account-tags.service";
import type { MessageSnapshot, Tag } from "@/domain/types";

/**
 * Sugestão a partir do vocabulário DA CONTA.
 *
 * A fixture são as 18 etiquetas reais da conta sondada. Não porque o código
 * as conheça — ele não conhece nenhuma —, mas porque foram elas que revelaram
 * o problema: a taxonomia própria do módulo não casava com nada, e a ação de
 * aplicar etiquetas nunca aplicaria coisa alguma.
 */
function tag(id: string, name: string): Tag {
  return { id, accountId: "acc1", name };
}

const CONTA_REAL: Tag[] = [
  tag("t1", "2k-4k"),
  tag("t2", "Meta ADS"),
  tag("t3", "Google"),
  tag("t4", "Indicação"),
  tag("t5", "4k-7k"),
  tag("t6", "Instagram"),
  tag("t7", "8k-15k"),
  tag("t8", "7k-8k"),
  tag("t9", "Beach Park"),
  tag("t10", "B2C"),
  tag("t11", "Follow 1"),
  tag("t12", "Atenção"),
  tag("t13", "FeedBack"),
  tag("t14", "PC Trabalho"),
  tag("t15", "PC Gamer"),
  tag("t16", "B2B"),
  tag("t17", "Vip"),
];

function msg(text: string, id = "m1"): MessageSnapshot {
  return {
    id,
    sessionId: "s1",
    direction: "INBOUND",
    text,
    sentAt: "2026-09-16T18:00:00Z",
  };
}

/* ==========================================================================
   Faixas de valor
   ========================================================================== */
describe("faixas de valor lidas do nome da etiqueta", () => {
  it("reconhece as quatro faixas da conta e ignora o resto", () => {
    const faixas = lerFaixasDeValor(CONTA_REAL);

    assert.deepEqual(
      faixas.map((f) => f.tag.name),
      ["2k-4k", "4k-7k", "7k-8k", "8k-15k"],
      "ordenadas do menor para o maior",
    );

    assert.equal(faixas[0]?.minimo, 2000);
    assert.equal(faixas[0]?.maximo, 4000);
    assert.equal(faixas[3]?.maximo, 15000);
  });

  it("aceita outros jeitos de escrever, porque cada conta escreve o seu", () => {
    const faixas = lerFaixasDeValor([
      tag("a", "1000-5000"),
      tag("b", "R$ 10k a 20k"),
      tag("c", "500 ate 900"),
    ]);

    assert.equal(faixas.length, 3);
    assert.deepEqual(
      faixas.map((f) => [f.minimo, f.maximo]),
      [
        [500, 900],
        [1000, 5000],
        [10000, 20000],
      ],
    );
  });

  it("nao inventa faixa a partir de nome que nao e intervalo", () => {
    // "Beach Park" tem espaço e duas palavras; "Follow 1" tem número.
    // Nenhum dos dois é faixa, e um palpite aqui etiquetaria contato errado.
    const faixas = lerFaixasDeValor([
      tag("a", "Beach Park"),
      tag("b", "Follow 1"),
      tag("c", "PC Gamer"),
      tag("d", "B2B"),
    ]);

    assert.deepEqual(faixas, []);
  });

  it("descarta intervalo invertido", () => {
    assert.deepEqual(lerFaixasDeValor([tag("a", "7k-2k")]), []);
  });

  it("sugere a faixa que contem o valor estimado", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: CONTA_REAL,
      messages: [],
      estimatedValue: 5000,
    });

    assert.equal(sugestoes.length, 1);
    assert.equal(sugestoes[0]?.tagName, "4k-7k");
    assert.equal(sugestoes[0]?.origem, "FAIXA_DE_VALOR");
  });

  it("nao sugere faixa nenhuma quando o valor esta fora de todas", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: CONTA_REAL,
      messages: [],
      estimatedValue: 90000,
    });

    assert.deepEqual(sugestoes, []);
  });

  it("nao sugere faixa quando nao ha valor estimado", () => {
    const sugestoes = sugerirEtiquetasDaConta({ tags: CONTA_REAL, messages: [] });
    assert.deepEqual(sugestoes, []);
  });
});

/* ==========================================================================
   Menção literal
   ========================================================================== */
describe("etiqueta mencionada literalmente na conversa", () => {
  it("sugere a etiqueta que o cliente citou, com o trecho", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: CONTA_REAL,
      messages: [
        msg("Eu quero montar um PC Gamer bom, mas que sirva pro trabalho também."),
      ],
    });

    const gamer = sugestoes.find((s) => s.tagName === "PC Gamer");
    assert.ok(gamer, "a menção existe e deveria virar sugestão");
    assert.equal(gamer.origem, "MENCAO_NA_CONVERSA");
    assert.match(gamer.trecho ?? "", /PC Gamer/, "o trecho precisa citar a conversa");
  });

  it("acha a menção mesmo com acento e caixa diferentes", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: CONTA_REAL,
      messages: [msg("cheguei por INDICACAO de um amigo")],
    });

    assert.ok(sugestoes.some((s) => s.tagName === "Indicação"));
  });

  /**
   * A regra que impede a sugestão de virar ruído. Sem borda de palavra,
   * "Vip" casaria dentro de "vipers" e "Google" dentro de "googlezinho".
   */
  it("exige palavra inteira, nao pedaco de outra palavra", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: [tag("a", "Vip"), tag("b", "Google")],
      messages: [msg("achei uns vipers no googlezinho da vida")],
    });

    assert.deepEqual(sugestoes, []);
  });

  it("nao usa nome curto demais como mencao", () => {
    // "B2B" tem 3 caracteres: casaria com ruído em conversa de WhatsApp.
    const sugestoes = sugerirEtiquetasDaConta({
      tags: [tag("a", "B2B")],
      messages: [msg("nosso modelo é b2b mesmo")],
    });

    assert.deepEqual(sugestoes, [], "decidir isto é papel da IA, com contexto");
  });

  it("nao sugere etiqueta de faixa por coincidencia de numero na conversa", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: CONTA_REAL,
      messages: [msg("o boleto veio 4k-7k parcelado, estranho isso")],
    });

    assert.deepEqual(
      sugestoes,
      [],
      "faixa se decide pelo valor da oportunidade, nunca por menção",
    );
  });

  it("nao repete a mesma etiqueta citada em varias mensagens", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: [tag("a", "PC Gamer")],
      messages: [
        msg("quero um PC Gamer", "m1"),
        msg("falei do PC Gamer ontem", "m2"),
        msg("sobre o PC Gamer de novo", "m3"),
      ],
    });

    assert.equal(sugestoes.length, 1);
  });

  it("junta faixa e mencao na mesma analise", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: CONTA_REAL,
      messages: [msg("quero um PC Gamer que sirva de PC Trabalho")],
      estimatedValue: 5000,
    });

    assert.deepEqual(
      sugestoes.map((s) => s.tagName).sort(),
      ["4k-7k", "PC Gamer", "PC Trabalho"],
    );
  });

  it("nao sugere nada quando a conta nao tem etiqueta", () => {
    const sugestoes = sugerirEtiquetasDaConta({
      tags: [],
      messages: [msg("quero um PC Gamer")],
      estimatedValue: 5000,
    });

    assert.deepEqual(sugestoes, []);
  });
});
