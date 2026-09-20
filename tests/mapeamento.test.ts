import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lerVocabularioDaDirecao,
  proporMapeamento,
} from "@/server/import/mapeamento";
import type { LinhaDaPlanilha } from "@/server/import/xlsx-reader";

/**
 * Proposta de mapeamento de colunas.
 *
 * Não sabemos o formato exato do relatório da KlipFlowi, e ele muda entre
 * versões e contas. Por isso o módulo propõe e a pessoa confirma — e por isso
 * os testes cobrem formatos diferentes do mesmo relatório, não um só.
 */

function linhas(colunas: string[], valores: string[][]): LinhaDaPlanilha[] {
  return valores.map((linha, indice) => {
    const registro: Record<string, string> = {};
    colunas.forEach((c, i) => {
      registro[c] = linha[i] ?? "";
    });
    // +2: a linha 1 e o cabecalho, e a planilha conta a partir de 1.
    return { numero: indice + 2, valores: registro };
  });
}

const UUID_A = "b574cc56-1d90-4792-8f74-7d03204d9f67";
const UUID_B = "52499961-399e-4a1a-b58a-dd4c8ce6b159";

describe("proposta de mapeamento", () => {
  it("reconhece um relatório com cabeçalhos em português", () => {
    const colunas = ["Atendimento", "Data", "Direção", "Mensagem", "Telefone"];
    const dados = linhas(colunas, [
      [
        UUID_A,
        "2026-09-16T18:25:43.000Z",
        "Recebida",
        "Boa tarde, eu estou precisando comprar um computador para trabalho e jogo",
        "(85) 99999-9962",
      ],
      [
        UUID_A,
        "2026-09-16T18:26:10.000Z",
        "Enviada",
        "Boa tarde! Aqui é o Pedro, consultor da UPAR. Como posso te ajudar hoje?",
        "(85) 99999-9962",
      ],
    ]);

    const { mapeamento, faltando } = proporMapeamento(colunas, dados);

    assert.deepEqual(faltando, [], "nada obrigatório pode faltar aqui");
    assert.equal(mapeamento.sessionId, "Atendimento");
    assert.equal(mapeamento.dataHora, "Data");
    assert.equal(mapeamento.direcao, "Direção");
    assert.equal(mapeamento.texto, "Mensagem");
    assert.equal(mapeamento.telefone, "Telefone");
  });

  /**
   * A heurística de nome sozinha morre num relatório traduzido. A de conteúdo
   * tem que sustentar o reconhecimento sozinha.
   */
  it("reconhece pelo formato dos valores quando o cabeçalho não ajuda", () => {
    const colunas = ["Coluna 1", "Coluna 2", "Coluna 3", "Coluna 4"];
    const dados = linhas(colunas, [
      [UUID_A, "2026-09-16T18:25:43.000Z", "in", "Boa tarde, preciso de um orçamento para uma máquina nova"],
      [UUID_A, "2026-09-16T18:26:10.000Z", "out", "Claro! Me conta o que você pretende fazer com ela, por favor"],
      [UUID_A, "2026-09-16T18:40:41.000Z", "in", "É para trabalho com gráficos e também para jogar à noite"],
    ]);

    const { mapeamento } = proporMapeamento(colunas, dados);

    assert.equal(mapeamento.dataHora, "Coluna 2", "datas são reconhecíveis sozinhas");
    assert.equal(mapeamento.direcao, "Coluna 3", "o vocabulário de direção é fechado");
    assert.equal(mapeamento.texto, "Coluna 4", "texto livre é longo e variado");
  });

  it("uma coluna não serve a dois campos", () => {
    const colunas = ["Atendimento", "Contato", "Data", "Direção", "Mensagem"];
    const dados = linhas(colunas, [
      [UUID_A, UUID_B, "2026-09-16T18:25:43.000Z", "Recebida", "boa tarde, quero um orçamento para computador"],
    ]);

    const { mapeamento } = proporMapeamento(colunas, dados);
    const usadas = Object.values(mapeamento);

    assert.equal(new Set(usadas).size, usadas.length, "nenhuma coluna repetida");
    assert.notEqual(mapeamento.sessionId, mapeamento.contatoId);
  });

  it("diz o que falta quando o obrigatório não está na planilha", () => {
    const colunas = ["Cliente", "Observação"];
    const dados = linhas(colunas, [["Cristiano", "nada aqui"]]);

    const { faltando } = proporMapeamento(colunas, dados);

    assert.ok(faltando.includes("dataHora"), "sem data não dá para ordenar");
    assert.ok(faltando.includes("direcao"), "sem direção não dá para saber quem falou");
  });

  /**
   * Número solto não é data. Sem essa guarda, uma coluna de quantidade ou de
   * valor viraria a coluna de data e a conversa inteira seria reordenada.
   */
  it("não confunde coluna numérica com data", () => {
    const colunas = ["Atendimento", "Quantidade", "Direção", "Mensagem"];
    const dados = linhas(colunas, [
      [UUID_A, "5", "Recebida", "preciso de cinco máquinas para o escritório novo"],
      [UUID_A, "12", "Enviada", "perfeito, vou montar um orçamento para as cinco unidades"],
    ]);

    const { mapeamento, faltando } = proporMapeamento(colunas, dados);

    assert.notEqual(mapeamento.dataHora, "Quantidade");
    assert.ok(faltando.includes("dataHora"), "melhor faltar do que apontar a coluna errada");
  });

  it("explica por que escolheu cada coluna", () => {
    const colunas = ["Atendimento", "Data", "Direção", "Mensagem"];
    const dados = linhas(colunas, [
      [UUID_A, "2026-09-16T18:25:43.000Z", "Recebida", "boa tarde, queria um orçamento de computador"],
    ]);

    const { sugestoes } = proporMapeamento(colunas, dados);
    const data = sugestoes.find((s) => s.campo === "dataHora");

    assert.ok(data?.porque && data.porque.length > 0, "a tela precisa mostrar o porquê");
    assert.ok((data?.confianca ?? 0) > 0.5, "nome e formato concordando dá confiança alta");
  });
});

/**
 * Vocabulário da direção.
 *
 * Trocar os dois lados atribui cada fala do cliente à equipe e inverte a
 * análise inteira. Foi o que aconteceu na leitura pela API, onde `FROM_HUB` —
 * que parece "saiu do sistema" — significa mensagem RECEBIDA do cliente.
 */
describe("vocabulário da direção", () => {
  it("entende os vocabulários conhecidos", () => {
    const { valores, precisaConfirmar } = lerVocabularioDaDirecao([
      "Recebida",
      "Enviada",
      "Recebida",
    ]);

    assert.equal(precisaConfirmar, false);
    assert.deepEqual(
      valores.map((v) => [v.valor, v.lado]),
      [
        ["Recebida", "INBOUND"],
        ["Enviada", "OUTBOUND"],
      ],
    );
  });

  it("entende o vocabulário da própria API, que é contraintuitivo", () => {
    const { valores } = lerVocabularioDaDirecao(["FROM_HUB", "TO_HUB"]);

    assert.equal(
      valores.find((v) => v.valor === "FROM_HUB")?.lado,
      "INBOUND",
      "FROM_HUB parece saída e é mensagem do cliente",
    );
    assert.equal(valores.find((v) => v.valor === "TO_HUB")?.lado, "OUTBOUND");
  });

  it("marca como desconhecido o que não reconhece, em vez de chutar um lado", () => {
    const { valores, precisaConfirmar } = lerVocabularioDaDirecao([
      "Recebida",
      "Nota interna",
    ]);

    assert.equal(precisaConfirmar, true, "a tela precisa perguntar");
    assert.equal(
      valores.find((v) => v.valor === "Nota interna")?.lado,
      "DESCONHECIDO",
      "chutar um lado inverteria a análise em silêncio",
    );
  });
});
