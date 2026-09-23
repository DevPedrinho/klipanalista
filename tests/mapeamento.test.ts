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

/**
 * Amostragem espalhada pelo arquivo.
 *
 * Achado contra um relatório real de atendimento (15.732 linhas): as
 * primeiras linhas de uma exportação de chat são quase sempre o fluxo de BOT
 * — a mesma saudação repetida para cliente atrás de cliente. Amostrar só o
 * início faz a heurística de "texto livre" ver pouca variedade e perder a
 * coluna de mensagem de verdade para uma coluna de UUID, que é sempre única
 * por construção.
 */
describe("detecção de coluna sobrevive a um início repetitivo", () => {
  /**
   * Reproduz o mecanismo do bug achado contra o relatório real
   * (`message-export-2026-09_1.xlsx`, 15.732 linhas): as PRIMEIRAS sessões do
   * arquivo por acaso são curtas e dominadas pelo fluxo de boas-vindas do
   * bot — poucas linhas reais, muitas templates repetidas. As sessões mais
   * adiante, a maioria, são atendimentos de verdade: uma saudação e depois
   * conversa variada de cliente.
   *
   * Uma amostra das PRIMEIRAS 40 linhas do arquivo real pegava só essas
   * poucas sessões iniciais — 47,5% de repetição, medido. Uma amostra
   * ESPALHADA alcança sessões de todo o arquivo, e a repetição dilui: medido
   * 90,2% de variedade no arquivo real, e é essa diferença que decide se a
   * coluna de mensagem (texto livre) ou a coluna de UUID (sempre única, por
   * construção) vence a disputa pelo campo "texto".
   *
   * Sessões de tamanho VARIÁVEL, de proposito: um período fixo alinhado ao
   * passo da amostra faria a amostragem sempre cair na mesma posição dentro
   * de cada sessão — um artefato do teste, não do bug real.
   */
  function relatorioComBotNoInicio(): LinhaDaPlanilha[] {
    const REAIS = [
      "Boa tarde, eu queria um orçamento para um computador para trabalho e jogo",
      "Claro! Me conta o que você pretende fazer com ela, se puder",
      "É para trabalho com gráficos e também para jogar à noite, tipo Battlefield",
      "Tenho uma dúvida sobre a garantia dos produtos que vocês vendem",
      "Vocês entregam para o Ceará inteiro ou só Fortaleza?",
      "Consegui aprovar o orçamento aqui com a diretoria, pode seguir",
      "Prefiro pagar parcelado em até 10 vezes no cartão de crédito",
      "Qual o prazo de montagem depois que o pedido é fechado?",
    ];
    const BOTS = [
      "Olá! Seja bem-vindo(a) à loja. Para começar, escolha uma opção de atendimento:",
      "Entendi! Para eu te direcionar, me conta o foco do atendimento hoje?",
      "Ótimo! Em instantes nossa equipe vai te atender.",
    ];

    function uuid(n: number): string {
      const hex = n.toString(16).padStart(8, "0");
      return `${hex}-0000-4000-8000-${"0".repeat(8)}${hex.slice(0, 4)}`;
    }

    const linhas: LinhaDaPlanilha[] = [];
    let numero = 2;
    let idMensagem = 0;
    let idReal = 0;

    function adicionar(texto: string): void {
      linhas.push({
        numero: numero++,
        valores: { "Mensagem/ID": uuid(idMensagem++), "Mensagem/Conteúdo": texto },
      });
    }

    // As primeiras 6 sessões: curtas, quase só bot — como o começo real do
    // arquivo.
    for (let sessao = 0; sessao < 6; sessao += 1) {
      for (let linhaDoBot = 0; linhaDoBot < 6; linhaDoBot += 1) {
        adicionar(BOTS[linhaDoBot % BOTS.length] as string);
      }
      adicionar(`${REAIS[idReal % REAIS.length]} (${idReal++})`);
    }

    // As 150 sessões seguintes: uma saudação e uma conversa real de tamanho
    // variável — o perfil típico do restante do arquivo.
    for (let sessao = 0; sessao < 150; sessao += 1) {
      adicionar(BOTS[0] as string);
      const mensagensReais = 3 + (sessao % 4);
      for (let i = 0; i < mensagensReais; i += 1) {
        adicionar(`${REAIS[idReal % REAIS.length]} (${idReal++})`);
      }
    }

    return linhas;
  }

  it("acha a coluna de mensagem mesmo com as primeiras sessões dominadas por bot", () => {
    const relatorio = relatorioComBotNoInicio();

    const { mapeamento } = proporMapeamento(
      ["Mensagem/ID", "Mensagem/Conteúdo"],
      relatorio,
    );

    assert.equal(
      mapeamento.texto,
      "Mensagem/Conteúdo",
      "a coluna de UUID (Mensagem/ID) não pode vencer a de texto de verdade",
    );
  });
});
