import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import {
  detectarColunaDaSessao,
  extrairIdDaSessao,
  montarIndiceDeSessoes,
} from "@/server/import/indice-de-sessoes";
import { proporMapeamento } from "@/server/import/mapeamento";
import { normalizarPlanilha } from "@/server/import/normalizar";
import { lerPlanilha, type LinhaDaPlanilha } from "@/server/import/xlsx-reader";

/**
 * A planilha como índice de atendimentos.
 *
 * O relatório real da KlipFlowi não traz transcrição de áudio, nem direção,
 * nem id de contato — mas traz, em toda linha, o LINK do atendimento. Daqui
 * sai só a lista de ids; o conteúdo vem da API, pela busca direta por id.
 *
 * O erro caro aqui não é deixar de achar um id: é achar o id ERRADO. A coluna
 * de id da mensagem também é UUID em toda linha, e escolhê-la trocaria 1.497
 * buscas que funcionam por 15.732 que dão 404.
 */

function linhas(colunas: string[], valores: string[][]): LinhaDaPlanilha[] {
  return valores.map((linha, indice) => {
    const registro: Record<string, string> = {};
    colunas.forEach((c, i) => {
      registro[c] = linha[i] ?? "";
    });
    return { numero: indice + 2, valores: registro };
  });
}

/** UUID determinístico, para montar fixtures com centenas de ids distintos. */
function uuid(n: number, prefixo = "a"): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixo.repeat(8)}-1d90-4792-8f74-${hex}`;
}

const LINK = (id: string) => `https://app.klipflowi.com/redirect?type=SESSION&id=${id}`;

describe("id do atendimento dentro da célula", () => {
  const ID = "b574cc56-1d90-4792-8f74-7d03204d9f67";

  it("lê o link que o relatório da KlipFlowi traz", () => {
    assert.equal(extrairIdDaSessao(LINK(ID)), ID);
  });

  it("lê o UUID solto, para relatório que já traga o id limpo", () => {
    assert.equal(extrairIdDaSessao(`  ${ID} `), ID);
  });

  it("aceita o id antes do tipo, e com mais parâmetros depois", () => {
    assert.equal(
      extrairIdDaSessao(`https://app.klipflowi.com/redirect?id=${ID}&type=SESSION&x=1`),
      ID,
    );
  });

  /**
   * Um link de contato carrega um UUID igualzinho. Buscá-lo como atendimento
   * daria 404 — ou, pior, a conversa de outra pessoa.
   */
  it("recusa link que se declara outra coisa", () => {
    assert.equal(extrairIdDaSessao(`https://app.klipflowi.com/redirect?type=CONTACT&id=${ID}`), null);
    assert.equal(extrairIdDaSessao(`https://app.klipflowi.com/redirect?type=CARD&id=${ID}`), null);
  });

  it("devolve em minúsculas, para o mesmo atendimento não contar duas vezes", () => {
    assert.equal(extrairIdDaSessao(ID.toUpperCase()), ID);
    assert.equal(extrairIdDaSessao(LINK(ID.toUpperCase())), ID);
  });

  it("não pesca UUID solto no meio de um texto qualquer", () => {
    assert.equal(extrairIdDaSessao(`veja o pedido ${ID} por favor`), null);
    assert.equal(extrairIdDaSessao(`https://exemplo.com/sessao/${ID}`), null);
    assert.equal(extrairIdDaSessao(`https://exemplo.com/?id=${ID}0`), null, "id mais longo não é UUID");
    assert.equal(extrairIdDaSessao(`https://exemplo.com/?uid=${ID}`), null, "outro parâmetro");
    assert.equal(extrairIdDaSessao(""), null);
  });
});

describe("qual coluna identifica o atendimento", () => {
  /**
   * Na planilha real, `Mensagem/ID` vem ANTES de `Conversa`, e as duas rendem
   * UUID em toda linha.
   */
  it("prefere o link do atendimento ao id da mensagem", () => {
    const dados = linhas(
      ["Mensagem/ID", "Conversa"],
      [
        [uuid(1, "b"), LINK(uuid(1))],
        [uuid(2, "b"), LINK(uuid(1))],
        [uuid(3, "b"), LINK(uuid(2))],
      ],
    );

    assert.equal(detectarColunaDaSessao(["Mensagem/ID", "Conversa"], dados)?.coluna, "Conversa");
  });

  /**
   * Sem nome nem link que ajudem, sobra o formato: id de atendimento se
   * repete (várias mensagens por conversa), id de mensagem nunca.
   */
  it("sem pista no nome, escolhe a coluna cujo id se repete", () => {
    const dados = linhas(
      ["A", "B"],
      [
        [uuid(1, "b"), uuid(1)],
        [uuid(2, "b"), uuid(1)],
        [uuid(3, "b"), uuid(2)],
        [uuid(4, "b"), uuid(2)],
      ],
    );

    assert.equal(detectarColunaDaSessao(["A", "B"], dados)?.coluna, "B");
  });

  it("com o mesmo formato, desempata pelo nome da coluna", () => {
    const dados = linhas(
      ["Outra", "Atendimento"],
      [
        [uuid(1, "b"), uuid(1)],
        [uuid(1, "b"), uuid(1)],
        [uuid(2, "b"), uuid(2)],
      ],
    );

    assert.equal(detectarColunaDaSessao(["Outra", "Atendimento"], dados)?.coluna, "Atendimento");
  });

  it("com o mesmo formato e sem nome que ajude, desempata pelo link que se declara atendimento", () => {
    const outroLink = (id: string) => `https://exemplo.com/abrir?id=${id}`;
    const dados = linhas(
      ["Link 1", "Link 2"],
      [
        [outroLink(uuid(1)), LINK(uuid(1))],
        [outroLink(uuid(1)), LINK(uuid(1))],
        [outroLink(uuid(2)), LINK(uuid(2))],
      ],
    );

    assert.equal(detectarColunaDaSessao(["Link 1", "Link 2"], dados)?.coluna, "Link 2");
  });

  it("não aceita coluna em que a maioria das linhas não rende id, por melhor que seja o nome", () => {
    const dados = linhas(
      ["Conversa"],
      [[LINK(uuid(1))], ["sem link"], ["também não"], ["nada"]],
    );

    assert.equal(detectarColunaDaSessao(["Conversa"], dados), null);
  });
});

describe("lista de atendimentos únicos", () => {
  const colunas = ["Conversa", "Contato", "Telefone", "Canal", "Data"];

  it("colapsa as mensagens em um item por atendimento, contando as linhas", () => {
    const dados = linhas(colunas, [
      [LINK(uuid(1)), "Cristiano", "(85) 99999-0001", "WhatsApp", "16/09/2026 15:30"],
      [LINK(uuid(1)), "Cristiano", "(85) 99999-0001", "WhatsApp", "16/09/2026 15:40"],
      [LINK(uuid(2)), "Marina", "", "Instagram", "10/09/2026 09:00"],
      [LINK(uuid(1)), "Cristiano", "(85) 99999-0001", "WhatsApp", "16/09/2026 15:25"],
    ]);

    const indice = montarIndiceDeSessoes(dados, "Conversa", {
      contatoNome: "Contato",
      telefone: "Telefone",
      canal: "Canal",
      dataHora: "Data",
    });

    assert.equal(indice.sessoes.length, 2);
    assert.equal(indice.totalDeLinhas, 4);

    const cristiano = indice.sessoes.find((s) => s.sessionId === uuid(1));
    assert.equal(cristiano?.linhas, 3);
    assert.equal(cristiano?.contatoNome, "Cristiano");
    assert.equal(cristiano?.telefone, "(85) 99999-0001");
    assert.equal(cristiano?.canal, "WhatsApp");
    assert.equal(cristiano?.primeiraMensagem, "2026-09-16T18:25:00.000Z", "a menor, não a primeira linha");
    assert.equal(cristiano?.ultimaMensagem, "2026-09-16T18:40:00.000Z", "a maior, não a última linha");

    const marina = indice.sessoes.find((s) => s.sessionId === uuid(2));
    assert.equal(marina?.telefone, undefined, "célula vazia não vira telefone vazio");
  });

  /**
   * Importar um mês leva minutos. Se a pessoa parar no meio, o que já foi
   * buscado precisa ser o que mais importa: o mais recente.
   */
  it("ordena do atendimento mais recente para o mais antigo", () => {
    const dados = linhas(colunas, [
      [LINK(uuid(1)), "", "", "", "01/09/2026 10:00"],
      [LINK(uuid(2)), "", "", "", "20/09/2026 10:00"],
      [LINK(uuid(3)), "", "", "", ""],
      [LINK(uuid(4)), "", "", "", "10/09/2026 10:00"],
    ]);

    const indice = montarIndiceDeSessoes(dados, "Conversa", { dataHora: "Data" });

    assert.deepEqual(
      indice.sessoes.map((s) => s.sessionId),
      [uuid(2), uuid(4), uuid(1), uuid(3)],
      "sem data vai para o fim",
    );
  });

  it("conta a linha sem id em vez de descartá-la em silêncio", () => {
    const dados = linhas(colunas, [
      [LINK(uuid(1)), "", "", "", ""],
      ["", "", "", "", ""],
      ["https://app.klipflowi.com/redirect?type=CONTACT&id=" + uuid(9), "", "", "", ""],
    ]);

    const indice = montarIndiceDeSessoes(dados, "Conversa");

    assert.equal(indice.sessoes.length, 1);
    assert.equal(indice.linhasSemId.quantidade, 2);
    assert.deepEqual(indice.linhasSemId.exemplos, [3, 4]);
  });
});

/**
 * Réplica do relatório real, com os mesmos cabeçalhos, a mesma ordem de
 * colunas e as mesmas armadilhas — nomes, telefones e textos trocados.
 *
 * Armadilhas que o arquivo real armou e que esta réplica preserva:
 *   - `Conta/Nome` é o nome da EMPRESA, igual em todas as linhas, e casa
 *     "nome" tão bem quanto `Contato/Nome`;
 *   - `Canal/Chave` (@empresa) vem antes de `Canal/Plataforma` (WhatsApp);
 *   - `Contato/Instagram` casava o padrão de id do contato;
 *   - `Mensagem/ID` é UUID em toda linha e vem antes de `Conversa`;
 *   - a data é célula de data de verdade, com formato brasileiro.
 */
async function replicaDoRelatorioReal(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");

  sheet.addRow([
    "Conta/Nome",
    "Canal/Chave",
    "Canal/Plataforma",
    "Contato/Nome",
    "Contato/Telefone",
    "Contato/Instagram",
    "Contato/Email",
    "Mensagem/ID",
    "Mensagem/Data de criação",
    "Mensagem/Quem enviou",
    "Mensagem/Conteúdo",
    "Conversa",
  ]);

  const frases = [
    "Olá! Seja bem-vindo à EMPRESA TESTE. Escolha uma opção abaixo:",
    "Boa tarde, queria saber o preço de um computador para jogos",
    "Temos várias opções, qual o seu orçamento aproximado?",
    "[Áudio] recorded_audio_webm.ogg: https://cdn.exemplo.com/audio.ogg",
    "Consigo pagar em até 10 vezes no cartão?",
    "Sim, parcelamos em até 12x sem juros no cartão de crédito.",
  ];

  let mensagem = 0;
  for (let sessao = 1; sessao <= 30; sessao += 1) {
    const instagram = sessao % 3 === 0;
    const contato = `Cliente ${sessao}`;

    for (let i = 0; i < 4; i += 1) {
      mensagem += 1;
      const quando = new Date(Date.UTC(2026, 8, sessao % 28 + 1, 12 + i, 5 * i));
      const doCliente = i % 2 === 1;

      sheet.addRow([
        "EMPRESA TESTE",
        "@empresa",
        instagram ? "Instagram" : "WhatsApp",
        contato,
        instagram ? "" : `(85) 9${String(sessao).padStart(4, "0")}-0000`,
        instagram ? `@cliente_${sessao}` : "",
        "",
        uuid(mensagem, "c"),
        quando,
        doCliente ? `De: ${contato} Para: EMPRESA TESTE` : `De: EMPRESA TESTE Para: ${contato}`,
        `${frases[(sessao + i) % frases.length]} (${sessao}.${i})`,
        LINK(uuid(sessao)),
      ]);
      sheet.getCell(sheet.rowCount, 9).numFmt = "dd/mm/yyyy hh:mm:ss";
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("contra a réplica do relatório real", () => {
  it("acha o link, e dele os atendimentos únicos, sem nenhuma falha", async () => {
    const planilha = await lerPlanilha(await replicaDoRelatorioReal());

    const coluna = detectarColunaDaSessao(planilha.cabecalhos, planilha.linhas);
    assert.equal(coluna?.coluna, "Conversa");

    const indice = montarIndiceDeSessoes(planilha.linhas, "Conversa");
    assert.equal(indice.sessoes.length, 30);
    assert.equal(indice.linhasSemId.quantidade, 0);
    assert.ok(indice.sessoes.every((s) => s.linhas === 4));
  });

  it("propõe cada coluna auxiliar certa, sem cair nas armadilhas", async () => {
    const planilha = await lerPlanilha(await replicaDoRelatorioReal());
    const { mapeamento } = proporMapeamento(planilha.cabecalhos, planilha.linhas);

    assert.equal(mapeamento.sessionId, "Conversa", "não o id da mensagem");
    assert.equal(mapeamento.texto, "Mensagem/Conteúdo");
    assert.equal(mapeamento.dataHora, "Mensagem/Data de criação");
    assert.equal(mapeamento.telefone, "Contato/Telefone");
    assert.equal(mapeamento.contatoNome, "Contato/Nome", "não o nome da empresa");
    assert.equal(mapeamento.canal, "Canal/Plataforma", "não a chave do canal");
    assert.equal(mapeamento.contatoId, undefined, "o relatório não tem id de contato");
    assert.equal(mapeamento.atendenteId, undefined);
  });

  /**
   * Modo reserva, sem API: a URL inteira não pode virar o id da conversa, ou
   * a mesma conversa nunca casaria com a versão que vem da API.
   */
  it("a normalização da planilha também usa o id de dentro do link", () => {
    const dados = linhas(
      ["Conversa", "Mensagem", "Quem", "Data"],
      [[LINK(uuid(7)), "Quero um orçamento de notebook", "Recebida", "16/09/2026 15:25"]],
    );

    const { conversas } = normalizarPlanilha(dados, {
      accountId: "klipflowi",
      mapeamento: { sessionId: "Conversa", texto: "Mensagem", direcao: "Quem", dataHora: "Data" },
      direcoes: { Recebida: "INBOUND" },
    });

    assert.equal(conversas[0]?.id, uuid(7));
    assert.equal(conversas[0]?.messages[0]?.sessionId, uuid(7));
  });
});

describe("armadilhas da detecção de colunas, uma a uma", () => {
  const variados = (prefixo: string) => Array.from({ length: 8 }, (_, i) => `${prefixo} ${i}`);

  function tabela(colunas: string[], porColuna: string[][]): LinhaDaPlanilha[] {
    const total = porColuna[0]?.length ?? 0;
    return linhas(
      colunas,
      Array.from({ length: total }, (_, i) => porColuna.map((valores) => valores[i] ?? "")),
    );
  }

  it("coluna de nome com o mesmo valor em todas as linhas não é o nome do contato", () => {
    const colunas = ["Nome", "Nome completo"];
    const dados = tabela(colunas, [Array(8).fill("EMPRESA TESTE"), variados("Pessoa")]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.contatoNome, "Nome completo");
  });

  it("entre dois nomes variados, prefere o que diz ser do cliente", () => {
    const colunas = ["Nome", "Nome do cliente"];
    const dados = tabela(colunas, [variados("Loja"), variados("Pessoa")]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.contatoNome, "Nome do cliente");
  });

  it("nome da conta não é nome do contato, mesmo sendo a única coluna de nome", () => {
    const colunas = ["Nome da conta"];
    const dados = tabela(colunas, [variados("Loja")]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.contatoNome, undefined);
  });

  it("canal é a coluna que diz a plataforma, não a que dá a chave", () => {
    const colunas = ["Canal/Chave", "Canal/Plataforma"];
    const dados = tabela(colunas, [
      Array(8).fill("@loja_teste"),
      ["WhatsApp", "Instagram", "WhatsApp", "WhatsApp", "Instagram", "WhatsApp", "WhatsApp", "WhatsApp"],
    ]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.canal, "Canal/Plataforma");
  });

  it("id do contato precisa dizer que é id — o @ do Instagram não é", () => {
    const colunas = ["Contato/Instagram"];
    const dados = tabela(colunas, [variados("@cliente").map((v) => v.replace(" ", "_"))]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.contatoId, undefined);
  });

  it("id do contato com nome explícito continua reconhecido", () => {
    const colunas = ["ID do contato"];
    const dados = tabela(colunas, [Array.from({ length: 8 }, (_, i) => uuid(i + 1))]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.contatoId, "ID do contato");
  });

  it("id do atendente que traz nome de gente não é id", () => {
    const colunas = ["ID do atendente"];
    const dados = tabela(colunas, [variados("Pedro Silva")]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.atendenteId, undefined);
  });

  it("link do atendimento é reconhecido pelo conteúdo, mesmo sem nome que ajude", () => {
    const colunas = ["Link"];
    const dados = tabela(colunas, [Array.from({ length: 8 }, (_, i) => LINK(uuid((i % 3) + 1)))]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.sessionId, "Link");
  });

  /**
   * "Atendimento" é também como muita planilha chama a coluna do RESPONSÁVEL.
   * Nome de gente tem espaço; id de atendimento, não.
   */
  it("coluna chamada atendimento que traz nome de gente não é o id do atendimento", () => {
    const colunas = ["Atendimento", "Link"];
    const dados = tabela(colunas, [
      variados("Pedro Silva"),
      Array.from({ length: 8 }, (_, i) => LINK(uuid((i % 3) + 1))),
    ]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.sessionId, "Link");
  });

  it("id da mensagem nunca é o id do atendimento", () => {
    const colunas = ["Mensagem/ID", "Protocolo", "Mensagem/Conteúdo"];
    const dados = tabela(colunas, [
      Array.from({ length: 8 }, (_, i) => uuid(i + 1, "c")),
      Array.from({ length: 8 }, (_, i) => `P${1000 + (i % 3)}`),
      Array.from({ length: 8 }, (_, i) => `Boa tarde, queria saber o preço do produto número ${i}`),
    ]);

    assert.equal(proporMapeamento(colunas, dados).mapeamento.sessionId, "Protocolo");
  });
});
