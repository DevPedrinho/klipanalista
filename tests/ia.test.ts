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
/** Dimensão de ICP neutra, para os testes que não investigam ICP. */
function dimensao(over: Partial<AnaliseDaIa["icp"]["orcamento"]> = {}) {
  return { nota: 0, justificativa: "não avaliado neste teste", trecho: null, ...over };
}

function analise(over: Partial<AnaliseDaIa> = {}): AnaliseDaIa {
  return {
    icp: {
      fitDeNecessidade: dimensao(),
      poderDeDecisao: dimensao(),
      orcamento: dimensao(),
      prazo: dimensao(),
      engajamento: dimensao(),
      perfilResumido: "cliente de teste",
    },
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

/**
 * Áudio transcrito: um único bloco longo, como chega da plataforma.
 *
 * É o formato que revelou o problema na conta real. A frase decisiva costuma
 * estar no meio, e recortar os primeiros 280 caracteres mostrava a abertura
 * do áudio — quase sempre a mesma saudação — em vez da evidência.
 */
const ABERTURA =
  "Oi, bom dia, tudo bem com você? Então, eu estava aqui pensando sobre aquilo " +
  "que a gente conversou, e eu andei pesquisando bastante, vi uns vídeos, vi " +
  "umas comparações, li umas análises, e fiquei um tempo em dúvida sobre qual " +
  "caminho seguir, porque tem muita opção e cada uma tem um detalhe diferente. ";
const FECHAMENTO =
  " De todo modo, depois a gente conversa com mais calma, porque agora eu " +
  "preciso sair para uma reunião e não quero decidir com pressa.";

const AUDIO_LONGO = msg({
  id: "m4",
  text: ABERTURA + "O orçamento já foi aprovado aqui pela diretoria." + FECHAMENTO,
  sentAt: "2026-03-01T11:00:00Z",
});

const PREPARADAS_LONGAS = paraTeste.prepararMensagens(conversa([AUDIO_LONGO]));

describe("evidência recortada de mensagem longa", () => {
  it("mostra a janela em volta da citação, não a abertura do áudio", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "orcamento ja foi aprovado",
            quemDisse: "CLIENTE",
            forca: 0.9,
          },
        ],
      }),
      PREPARADAS_LONGAS,
    );

    const excerpt = resultado.sinais[0]?.excerpt ?? "";

    assert.ok(
      excerpt.includes("orçamento já foi aprovado"),
      `a evidência precisa conter a citação: ${excerpt}`,
    );
    assert.ok(
      !excerpt.startsWith("Oi, bom dia"),
      "começar pela saudação é exatamente o defeito que isto corrige",
    );
    assert.ok(excerpt.length <= 290, `evidência longa demais: ${excerpt.length}`);
  });

  it("a evidência continua sendo texto literal da conversa", () => {
    const resultado = verificarAnalise(
      analise({
        sinais: [
          {
            codigo: "ORCAMENTO_APROVADO",
            trecho: "orcamento ja foi aprovado",
            quemDisse: "CLIENTE",
            forca: 0.9,
          },
        ],
      }),
      PREPARADAS_LONGAS,
    );

    // Sem as reticências de corte, o que sobra tem que existir na mensagem.
    const miolo = (resultado.sinais[0]?.excerpt ?? "").replace(/^\.\.\.|\.\.\.$/g, "");

    assert.ok(
      AUDIO_LONGO.text.includes(miolo),
      "a evidência exibida não é recorte literal da mensagem",
    );
  });
});

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

describe("ICP — perfil de cliente ideal", () => {
  /**
   * O ICP responde uma pergunta diferente do score de oportunidade:
   *
   *   score de oportunidade -> quanto este negócio merece atenção AGORA
   *   ICP                   -> quanto este cliente se parece com quem compra
   *
   * Os dois se separam na prática o tempo todo, e é essa separação que faz o
   * vendedor escolher onde gastar a próxima hora.
   */
  it("soma as dimensões e classifica a faixa", () => {
    const resultado = verificarAnalise(
      analise({
        icp: {
          fitDeNecessidade: dimensao({
            nota: 25,
            trecho: "preciso de 200 metros de cabo flexível",
          }),
          poderDeDecisao: dimensao({
            nota: 20,
            trecho: "O orçamento já foi aprovado aqui pela diretoria",
          }),
          orcamento: dimensao({ nota: 20, trecho: "orcamento ja foi aprovado" }),
          prazo: dimensao({ nota: 10, trecho: null }),
          engajamento: dimensao({ nota: 10, trecho: null }),
          perfilResumido: "Comprador industrial com verba aprovada.",
        },
      }),
      PREPARADAS,
    );

    assert.equal(resultado.icp.total, 85);
    assert.equal(resultado.icp.faixa, "ALTO");
  });

  /**
   * A regra que dá confiança ao número: uma nota alta com justificativa
   * convincente e trecho inexistente é exatamente o que leva um vendedor a
   * priorizar o cliente errado.
   */
  it("ZERA a dimensão cujo trecho não existe na conversa", () => {
    const resultado = verificarAnalise(
      analise({
        icp: {
          fitDeNecessidade: dimensao({
            nota: 25,
            justificativa: "Cliente detalhou exatamente o produto.",
            trecho: "quero fechar 500 unidades ainda hoje",
          }),
          poderDeDecisao: dimensao(),
          orcamento: dimensao(),
          prazo: dimensao(),
          engajamento: dimensao(),
          perfilResumido: "x",
        },
      }),
      PREPARADAS,
    );

    const fit = resultado.icp.dimensoes.find((d) => d.chave === "fitDeNecessidade");
    assert.equal(fit?.nota, 0, "afirmação sem lastro não pode somar pontos");
    assert.equal(fit?.evidenciaRejeitada, true);
    assert.equal(resultado.icp.total, 0);
    assert.ok(resultado.descartados.some((d) => d.codigo === "ICP:fitDeNecessidade"));
  });

  /**
   * Distinção que importa: "a conversa não falou disso" é uma observação
   * legítima; "citei algo que ninguém disse" é invenção. Confundir as duas
   * faria o módulo punir o silêncio como se fosse mentira.
   */
  it("trecho nulo não é rejeição — é a conversa não ter falado do assunto", () => {
    const resultado = verificarAnalise(
      analise({
        icp: {
          fitDeNecessidade: dimensao({ nota: 0, trecho: null }),
          poderDeDecisao: dimensao({ nota: 0, trecho: null }),
          orcamento: dimensao({ nota: 5, trecho: null }),
          prazo: dimensao({ nota: 0, trecho: null }),
          engajamento: dimensao({ nota: 0, trecho: null }),
          perfilResumido: "x",
        },
      }),
      PREPARADAS,
    );

    assert.equal(resultado.icp.total, 5, "nota sem trecho continua valendo");
    assert.ok(
      resultado.icp.dimensoes.every((d) => d.evidenciaRejeitada === false),
      "silêncio não é invenção",
    );
    assert.deepEqual(resultado.descartados, []);
  });

  it("limita a nota ao máximo da dimensão", () => {
    const resultado = verificarAnalise(
      analise({
        icp: {
          // 999 no fit, cujo máximo é 25.
          fitDeNecessidade: dimensao({
            nota: 999,
            trecho: "preciso de 200 metros de cabo flexível",
          }),
          poderDeDecisao: dimensao(),
          orcamento: dimensao(),
          prazo: dimensao(),
          engajamento: dimensao(),
          perfilResumido: "x",
        },
      }),
      PREPARADAS,
    );

    assert.equal(resultado.icp.total, 25);
  });

  it("classifica as três faixas pelos cortes definidos", () => {
    const comTotal = (nota: number) =>
      verificarAnalise(
        analise({
          icp: {
            fitDeNecessidade: dimensao({ nota: Math.min(25, nota), trecho: null }),
            poderDeDecisao: dimensao({ nota: Math.min(20, Math.max(0, nota - 25)), trecho: null }),
            orcamento: dimensao({ nota: Math.min(20, Math.max(0, nota - 45)), trecho: null }),
            prazo: dimensao({ nota: Math.min(20, Math.max(0, nota - 65)), trecho: null }),
            engajamento: dimensao({ nota: Math.min(15, Math.max(0, nota - 85)), trecho: null }),
            perfilResumido: "x",
          },
        }),
        PREPARADAS,
      ).icp;

    assert.equal(comTotal(90).faixa, "ALTO");
    assert.equal(comTotal(50).faixa, "MEDIO");
    assert.equal(comTotal(20).faixa, "BAIXO");
  });

  it("devolve as cinco dimensões, sempre, com rótulo legível", () => {
    const resultado = verificarAnalise(analise(), PREPARADAS);

    assert.equal(resultado.icp.dimensoes.length, 5);
    assert.deepEqual(
      resultado.icp.dimensoes.map((d) => d.rotulo),
      ["Fit de necessidade", "Poder de decisão", "Orçamento", "Prazo de compra", "Engajamento"],
    );
    assert.equal(
      resultado.icp.dimensoes.reduce((acc, d) => acc + d.maximo, 0),
      100,
      "os máximos precisam somar 100",
    );
  });
});
