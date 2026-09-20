import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import {
  MAX_LINHAS_PADRAO,
  PlanilhaInvalida,
  lerPlanilha,
  pareceXlsx,
} from "@/server/import/xlsx-reader";

/**
 * Leitor de planilha.
 *
 * Os testes montam um `.xlsx` de verdade em memória e leem de volta — não há
 * fixture de mentira aqui. É o único jeito de provar que data, fórmula e texto
 * formatado saem certos, porque cada um desses é guardado de um jeito
 * diferente dentro do arquivo.
 */

interface Celula {
  valor: unknown;
  formato?: string;
}

/** Monta um .xlsx em memória a partir de uma matriz. */
async function planilha(
  linhas: (string | number | Date | Celula | null)[][],
  opcoes: { aba?: string; segundaAba?: string } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opcoes.aba ?? "Atendimentos");

  for (const linha of linhas) {
    const row = sheet.addRow(
      linha.map((c) => (c !== null && typeof c === "object" && "valor" in c ? c.valor : c)),
    );
    linha.forEach((c, i) => {
      if (c !== null && typeof c === "object" && "valor" in c && c.formato) {
        row.getCell(i + 1).numFmt = c.formato;
      }
    });
  }

  if (opcoes.segundaAba) workbook.addWorksheet(opcoes.segundaAba);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("leitor de planilha", () => {
  it("lê cabeçalho e linhas", async () => {
    const buffer = await planilha([
      ["Atendimento", "Mensagem", "Direção"],
      ["s1", "bom dia", "Recebida"],
      ["s1", "bom dia, como posso ajudar", "Enviada"],
    ]);

    const lida = await lerPlanilha(buffer);

    assert.deepEqual(lida.cabecalhos, ["Atendimento", "Mensagem", "Direção"]);
    assert.equal(lida.linhas.length, 2);
    assert.equal(lida.linhas[0]?.["Mensagem"], "bom dia");
    assert.equal(lida.linhas[1]?.["Direção"], "Enviada");
    assert.equal(lida.abaLida, "Atendimentos");
  });

  /**
   * O caso que estraga a análise em silêncio. O Excel guarda data como número
   * de série; uma leitura ingênua devolve 45916 no lugar de 2026-09-16. Como a
   * data ordena as mensagens e define a recência da conversa, errar aqui não
   * dá erro — dá análise errada.
   */
  it("devolve data como ISO, não como número de série do Excel", async () => {
    const quando = new Date("2026-09-16T18:25:43.000Z");
    const buffer = await planilha([
      ["Mensagem", "Data"],
      ["bom dia", { valor: quando, formato: "dd/mm/yyyy hh:mm" }],
    ]);

    const lida = await lerPlanilha(buffer);
    const bruto = lida.linhas[0]?.["Data"] ?? "";

    assert.ok(
      Number.isFinite(Date.parse(bruto)),
      `a data precisa ser legível, veio: ${bruto}`,
    );
    assert.equal(new Date(bruto).getTime(), quando.getTime());
  });

  it("entende texto formatado e fórmula", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados");
    sheet.addRow(["Mensagem", "Total"]);

    const linha = sheet.addRow([null, null]);
    linha.getCell(1).value = {
      richText: [
        { text: "quero um " },
        { text: "PC Gamer", font: { bold: true } },
      ],
    };
    linha.getCell(2).value = { formula: "1+1", result: 2, date1904: false };

    const lida = await lerPlanilha(Buffer.from(await workbook.xlsx.writeBuffer()));

    assert.equal(lida.linhas[0]?.["Mensagem"], "quero um PC Gamer");
    assert.equal(lida.linhas[0]?.["Total"], "2", "vale o resultado, não a fórmula");
  });

  it("pula as linhas em branco antes do cabeçalho", async () => {
    // Relatório exportado costuma vir com título e filtros antes da tabela.
    const buffer = await planilha([
      [null, null],
      [null, null],
      ["Atendimento", "Mensagem"],
      ["s1", "bom dia"],
    ]);

    const lida = await lerPlanilha(buffer);

    assert.deepEqual(lida.cabecalhos, ["Atendimento", "Mensagem"]);
    assert.equal(lida.linhas.length, 1);
  });

  /**
   * Duas colunas com o mesmo nome fariam uma sobrescrever a outra ao virar
   * chave do objeto — metade dos dados sumiria sem nenhum erro.
   */
  it("não deixa coluna repetida engolir a outra", async () => {
    const buffer = await planilha([
      ["Nome", "Nome", ""],
      ["contato", "atendente", "solto"],
    ]);

    const lida = await lerPlanilha(buffer);

    assert.equal(new Set(lida.cabecalhos).size, lida.cabecalhos.length, "sem repetição");
    assert.equal(lida.linhas[0]?.["Nome"], "contato");
    assert.equal(lida.linhas[0]?.["Nome (2)"], "atendente");
    assert.ok(
      lida.cabecalhos.some((c) => c.startsWith("Coluna")),
      "coluna sem título ganha nome próprio em vez de virar chave vazia",
    );
  });

  it("descarta linha totalmente vazia e conta quantas", async () => {
    const buffer = await planilha([
      ["Mensagem"],
      ["bom dia"],
      [null],
      ["boa tarde"],
    ]);

    const lida = await lerPlanilha(buffer);

    assert.equal(lida.linhas.length, 2);
    assert.deepEqual(
      lida.linhas.map((l) => l["Mensagem"]),
      ["bom dia", "boa tarde"],
    );
  });

  it("lista as abas e deixa escolher outra", async () => {
    const buffer = await planilha(
      [["Mensagem"], ["bom dia"]],
      { aba: "Atendimentos", segundaAba: "Resumo" },
    );

    const lida = await lerPlanilha(buffer);
    assert.deepEqual(lida.abas, ["Atendimentos", "Resumo"]);

    await assert.rejects(
      () => lerPlanilha(buffer, { aba: "Inexistente" }),
      (erro: Error) => erro instanceof PlanilhaInvalida && /Abas disponiveis/.test(erro.message),
    );
  });

  it("respeita o teto de linhas", async () => {
    const linhas: string[][] = [["Mensagem"]];
    for (let i = 0; i < 30; i += 1) linhas.push([`mensagem ${i}`]);

    const lida = await lerPlanilha(await planilha(linhas), { maxLinhas: 10 });
    assert.equal(lida.linhas.length, 10);
    assert.ok(MAX_LINHAS_PADRAO > 10, "o teto padrão é bem maior que o do teste");
  });

  describe("recusa o que não é planilha", () => {
    it("recusa arquivo que não é xlsx", async () => {
      await assert.rejects(
        () => lerPlanilha(Buffer.from("Atendimento,Mensagem\ns1,bom dia")),
        (erro: Error) => erro instanceof PlanilhaInvalida && /\.xlsx/.test(erro.message),
      );
    });

    it("reconhece a assinatura de zip", () => {
      assert.equal(pareceXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
      assert.equal(pareceXlsx(Buffer.from("texto puro")), false);
      assert.equal(pareceXlsx(Buffer.from([0x50])), false, "curto demais");
    });

    it("recusa planilha sem nenhum conteúdo", async () => {
      const buffer = await planilha([[null], [null]]);

      await assert.rejects(
        () => lerPlanilha(buffer),
        (erro: Error) => erro instanceof PlanilhaInvalida && /vazia/.test(erro.message),
      );
    });
  });
});
