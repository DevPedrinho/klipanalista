import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationSnapshot, MessageSnapshot } from "@/domain/types";
import {
  verificarAnalise,
  paraTeste,
  type AnaliseDaIa,
} from "@/server/ai/opportunity-analyst";

/**
 * A garantia anti-invenção.
 *
 * Este é o teste que decide se dá para confiar na análise por IA. O modelo
 * pode escrever qualquer coisa de forma convincente; o que impede uma
 * oportunidade fabricada de chegar à tela é a conferência do trecho contra as
 * mensagens reais.
 *
 * Nenhuma chamada de API acontece aqui: `verificarAnalise` é pura, justamente
 * para que a regra mais importante do módulo seja testável sem rede, sem
 * credencial e sem custo.
 */

function msg(over: Partial<MessageSnapshot> & { text: string }): MessageSnapshot {
  return {
    id: "m1",
    sessionId: "sess_1",
    direction: "INBOUND",
    sentAt: "2026-03-01T10:00:00Z",
    ...over,
  };
}

function conversa(mensagens: MessageSnapshot[]): ConversationSnapshot {
  return {
    id: "sess_1",
    accountId: "acc_1",
    contactId: "contact_1",
    channel: "WHATSAPP",
    status: "OPEN",
    startedAt: "2026-03-01T09:00:00Z",
    lastMessageAt: "2026-03-01T10:00:00Z",
    messages: mensagens,
  };
}

/** Molde de resposta do modelo, para variar só o que o teste investiga. */
function analise(over: Partial<AnaliseDaIa> = {}): AnaliseDaIa {
  return {
    temSinalComercial: true,
    resumoDaNecessidade: "Cliente quer comprar.",
    produtoDeInteresse: null,
    sinais: [],
    objecoes: [],
    proximoPasso: "Retomar o contato.",
    valorMencionado: null,
    justificativa: "Teste.",
    ...over,
  };
}

const MENSAGENS = [
  msg({ id: "m1", text: "Bom dia, preciso de 200 metros de cabo flexível" }),
  msg({
    id: "m2",
    direction: "OUTBOUND",
    text: "Bom dia! Vou preparar o orçamento e te envio hoje.",
    sentAt: "2026-03-01T10:05:00Z",
  }),
  msg({
    id: "m3",
    text: "O orçamento já foi aprovado aqui pela diretoria",
    sentAt: "2026-03-01T10:30:00Z",
  }),
];

const PREPARADAS = paraTeste.prepararMensagens(conversa(MENSAGENS));

describe("verificação de trecho — a barreira contra invenção", () => {
  it("aceita o sinal quando o trecho existe mesmo na conversa", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "O orçamento já foi aprovado aqui pela diretoria",
            quemDisse: "CLIENTE",
            forca: 0.95,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.equal(resultado.sinais.length, 1);
    assert.equal(resultado.sinais[0]?.code, "ORCAMENTO_APROVADO");
    assert.equal(resultado.sinais[0]?.messageId, "m3", "o sinal aponta a mensagem real");
    assert.deepEqual(resultado.descartados, []);
  });

  /**
   * O caso que justifica o módulo inteiro. Um modelo pode produzir uma frase
   * perfeitamente plausível que ninguém disse — e uma oportunidade fabricada
   * é pior que oportunidade nenhuma, porque o time age em cima dela.
   */
  it("DESCARTA o sinal cujo trecho não aparece na conversa", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "Pode faturar, já está tudo aprovado e liberado",
            quemDisse: "CLIENTE",
            forca: 1,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.deepEqual(resultado.sinais, [], "nada inventado pode virar sinal");
    assert.equal(resultado.descartados.length, 1);
    assert.match(resultado.descartados[0]!.motivo, /nao encontrado/);
  });

  it("descarta código fora do catálogo curado", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "CLIENTE_MUITO_ANIMADO",
            trecho: "O orçamento já foi aprovado aqui pela diretoria",
            quemDisse: "CLIENTE",
            forca: 0.9,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.deepEqual(resultado.sinais, []);
    assert.match(resultado.descartados[0]!.motivo, /fora do catalogo/);
  });

  it("tolera acento e pontuação, que o modelo pode normalizar ao copiar", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "o orcamento ja foi aprovado aqui pela diretoria!",
            quemDisse: "CLIENTE",
            forca: 0.9,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.equal(resultado.sinais.length, 1, "diferença de acento não é invenção");
  });

  it("não aceita trecho curto demais para provar qualquer coisa", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          { codigo: "ORCAMENTO_APROVADO", trecho: "sim", quemDisse: "CLIENTE", forca: 1 },
        ],
      }),
      PREPARADAS,
    );

    assert.deepEqual(resultado.sinais, [], "'sim' aparece em quase toda conversa");
  });

  it("a evidência exibida é o texto da mensagem, não o que o modelo digitou", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            // Recorte parcial: o modelo citou só um pedaço.
            trecho: "orcamento ja foi aprovado",
            quemDisse: "CLIENTE",
            forca: 0.9,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.equal(
      resultado.sinais[0]?.excerpt,
      "O orçamento já foi aprovado aqui pela diretoria",
      "quem lê a tela precisa ver a frase real, completa",
    );
  });

  it("o mesmo código citado duas vezes não vale o dobro", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "O orçamento já foi aprovado aqui pela diretoria",
            quemDisse: "CLIENTE",
            forca: 0.9,
          },
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "orcamento ja foi aprovado",
            quemDisse: "CLIENTE",
            forca: 0.8,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.equal(resultado.sinais.length, 1);
  });

  it("limita a força ao intervalo de 0 a 1, venha o que vier", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "O orçamento já foi aprovado aqui pela diretoria",
            quemDisse: "CLIENTE",
            forca: 47,
          },
        ],
      }),
      PREPARADAS,
    );

    assert.equal(resultado.sinais[0]?.strength, 1);
  });
});

describe("mascaramento antes de sair do servidor", () => {
  /**
   * A conversa vai para um provedor externo. Telefone, e-mail, CPF e CNPJ
   * saem mascarados — a análise não precisa deles para entender a intenção
   * de compra, então mandá-los seria exposição sem contrapartida.
   */
  it("mascara telefone, e-mail, CPF e CNPJ no texto da mensagem", () => {
    const texto = paraTeste.mascarar(
      "Me chama no 11 98765-4321 ou joao@empresa.com.br. " +
        "CPF 123.456.789-01, CNPJ 12.345.678/0001-99",
    );

    assert.ok(!texto.includes("98765-4321"), `telefone vazou: ${texto}`);
    assert.ok(!texto.includes("joao@empresa.com.br"), `e-mail vazou: ${texto}`);
    assert.ok(!texto.includes("123.456.789-01"), `CPF vazou: ${texto}`);
    assert.ok(!texto.includes("12.345.678/0001-99"), `CNPJ vazou: ${texto}`);
  });

  it("não estraga o texto comercial ao mascarar", () => {
    const texto = paraTeste.mascarar("Preciso de 200 metros de cabo, orçamento aprovado");
    assert.equal(texto, "Preciso de 200 metros de cabo, orçamento aprovado");
  });

  it("preserva valores em reais, que a análise precisa ler", () => {
    const texto = paraTeste.mascarar("Fechamos por R$ 12.500,00?");
    assert.ok(texto.includes("12.500,00"), `valor foi mascarado por engano: ${texto}`);
  });

  it("envia apenas mensagens com texto", () => {
    const preparadas = paraTeste.prepararMensagens(
      conversa([
        msg({ id: "a", text: "tenho interesse" }),
        msg({ id: "b", text: "   " }),
        msg({ id: "c", text: "" }),
      ]),
    );

    assert.equal(preparadas.length, 1, "mensagem de mídia sem texto não vira chamada");
  });
});
