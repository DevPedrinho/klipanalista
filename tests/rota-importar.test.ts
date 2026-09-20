import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { MAX_BYTES, POST } from "@/app/api/intelligence/importar/route";

/**
 * Rota de importação.
 *
 * É a porta de entrada da planilha, e o lugar onde dois erros previsíveis
 * precisam virar frase em português em vez de falha opaca: arquivo grande
 * demais (a plataforma recusa antes do código rodar) e arquivo que não é
 * planilha.
 */

const SESSAO = "b574cc56-1d90-4792-8f74-7d03204d9f67";

async function planilhaDeExemplo(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Atendimentos");

  sheet.addRow(["Atendimento", "Data", "Direção", "Mensagem", "Telefone"]);
  sheet.addRow([
    SESSAO,
    "16/09/2026 15:25",
    "Recebida",
    "Boa tarde, eu estou precisando comprar um computador para trabalho e jogo",
    "(85) 99999-9962",
  ]);
  sheet.addRow([
    SESSAO,
    "16/09/2026 15:26",
    "Enviada",
    "Boa tarde! Aqui é o Pedro, consultor da UPAR. Como posso te ajudar?",
    "(85) 99999-9962",
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pedido(campos: Record<string, string | Blob>): NextRequest {
  const form = new FormData();
  for (const [chave, valor] of Object.entries(campos)) form.append(chave, valor);

  return new NextRequest("http://localhost/api/intelligence/importar", {
    method: "POST",
    body: form,
  });
}

function arquivo(buffer: Buffer, nome = "relatorio.xlsx"): File {
  return new File([new Uint8Array(buffer)], nome, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function corpo(resposta: Response): Promise<Record<string, unknown>> {
  return (await resposta.json()) as Record<string, unknown>;
}

describe("rota de importação — primeiro passo, propor o mapeamento", () => {
  it("devolve cabeçalhos, amostra e proposta quando o mapeamento não veio", async () => {
    const resposta = await POST(
      pedido({ accountId: "klipflowi", arquivo: arquivo(await planilhaDeExemplo()) }),
    );

    assert.equal(resposta.status, 200);

    const body = await corpo(resposta);
    const dados = body["data"] as Record<string, unknown>;

    assert.equal(dados["etapa"], "MAPEAR");
    assert.deepEqual(dados["abas"], ["Atendimentos"]);
    assert.equal(dados["totalDeLinhas"], 2);

    const proposta = dados["proposta"] as { mapeamento: Record<string, string> };
    assert.equal(proposta.mapeamento["texto"], "Mensagem");
    assert.equal(proposta.mapeamento["dataHora"], "Data");

    const vocabulario = dados["vocabularioDaDirecao"] as { precisaConfirmar: boolean };
    assert.equal(vocabulario.precisaConfirmar, false, "Recebida/Enviada são conhecidas");
  });
});

describe("rota de importação — segundo passo, normalizar", () => {
  it("devolve as conversas quando o mapeamento vem confirmado", async () => {
    const resposta = await POST(
      pedido({
        accountId: "klipflowi",
        arquivo: arquivo(await planilhaDeExemplo()),
        mapeamento: JSON.stringify({
          sessionId: "Atendimento",
          dataHora: "Data",
          direcao: "Direção",
          texto: "Mensagem",
          telefone: "Telefone",
        }),
      }),
    );

    assert.equal(resposta.status, 200);

    const dados = (await corpo(resposta))["data"] as Record<string, unknown>;
    const conversas = dados["conversas"] as { id: string; messages: unknown[] }[];

    assert.equal(dados["etapa"], "NORMALIZADO");
    assert.equal(conversas.length, 1, "duas linhas do mesmo atendimento, uma conversa");
    assert.equal(conversas[0]?.id, SESSAO);
    assert.equal(conversas[0]?.messages.length, 2);
    assert.equal(dados["mensagens"], 2);
  });

  /**
   * O erro mais caro que esta rota pode cometer.
   *
   * Um valor de direção que ninguém reconhece — "Nota interna", "Sistema",
   * "Bot" — não pode cair num lado por padrão. Atribuído ao cliente, ele vira
   * evidência de intenção de compra que o cliente nunca demonstrou; atribuído
   * à equipe, some da análise. A linha é recusada com nome, e a tela pergunta.
   */
  it("recusa a linha quando não sabe de que lado veio, em vez de chutar", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Atendimentos");
    sheet.addRow(["Atendimento", "Data", "Direção", "Mensagem"]);
    sheet.addRow([SESSAO, "16/09/2026 15:25", "Recebida", "quero um orçamento de PC"]);
    sheet.addRow([SESSAO, "16/09/2026 15:26", "Nota interna", "cliente parece decidido"]);

    const resposta = await POST(
      pedido({
        accountId: "klipflowi",
        arquivo: arquivo(Buffer.from(await workbook.xlsx.writeBuffer())),
        mapeamento: JSON.stringify({
          sessionId: "Atendimento",
          dataHora: "Data",
          direcao: "Direção",
          texto: "Mensagem",
        }),
      }),
    );

    const dados = (await corpo(resposta))["data"] as Record<string, unknown>;
    const conversas = dados["conversas"] as { messages: unknown[] }[];
    const rejeicoes = dados["rejeicoes"] as { motivo: string; amostraDeValores: string[] }[];

    assert.equal(conversas[0]?.messages.length, 1, "só a mensagem reconhecida entra");
    assert.ok(
      rejeicoes.some(
        (r) => /Direcao nao reconhecida/.test(r.motivo) &&
          r.amostraDeValores.includes("Nota interna"),
      ),
      "a tela precisa saber qual valor não foi entendido",
    );
  });

  /**
   * O formato brasileiro `16/09/2026 15:25` é o que o relatório traz, e é
   * exatamente o que o `Date.parse` não entende. Se isto quebrar, a planilha
   * inteira volta rejeitada.
   */
  it("lê a data no formato brasileiro sem rejeitar nada", async () => {
    const resposta = await POST(
      pedido({
        accountId: "klipflowi",
        arquivo: arquivo(await planilhaDeExemplo()),
        mapeamento: JSON.stringify({
          sessionId: "Atendimento",
          dataHora: "Data",
          direcao: "Direção",
          texto: "Mensagem",
        }),
      }),
    );

    const dados = (await corpo(resposta))["data"] as Record<string, unknown>;

    assert.deepEqual(dados["rejeicoes"], [], "nenhuma linha pode ser recusada aqui");
  });
});

describe("o que a rota recusa, com frase em português", () => {
  it("recusa arquivo acima do limite dizendo o tamanho e o teto", async () => {
    const grande = Buffer.alloc(MAX_BYTES + 1024, 0x50);

    const resposta = await POST(
      pedido({ accountId: "klipflowi", arquivo: arquivo(grande) }),
    );

    assert.equal(resposta.status, 400);

    const erro = (await corpo(resposta))["error"] as { message: string };
    assert.match(erro.message, /MB/, "a mensagem precisa dizer os tamanhos");
    assert.match(erro.message, /importe em partes/i, "e o que fazer a respeito");
  });

  it("recusa arquivo que não é planilha", async () => {
    const resposta = await POST(
      pedido({
        accountId: "klipflowi",
        arquivo: arquivo(Buffer.from("Atendimento,Mensagem\ns1,bom dia"), "relatorio.csv"),
      }),
    );

    assert.equal(resposta.status, 400);
    const erro = (await corpo(resposta))["error"] as { message: string };
    assert.match(erro.message, /\.xlsx/);
  });

  it("recusa pedido sem arquivo", async () => {
    const resposta = await POST(pedido({ accountId: "klipflowi" }));

    assert.equal(resposta.status, 400);
    const erro = (await corpo(resposta))["error"] as { message: string };
    assert.match(erro.message, /arquivo/i);
  });

  it("recusa mapeamento que não é JSON válido", async () => {
    const resposta = await POST(
      pedido({
        accountId: "klipflowi",
        arquivo: arquivo(await planilhaDeExemplo()),
        mapeamento: "{isto não é json",
      }),
    );

    assert.equal(resposta.status, 400);
    const erro = (await corpo(resposta))["error"] as { message: string };
    assert.match(erro.message, /JSON/);
  });
});
