import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationSnapshot, MessageSnapshot } from "@/domain/types";
import { computeScore, SCORE_DISPLAY_THRESHOLD, classifyPriority } from "@/server/scoring/score";
import { detectObjections, detectSignals } from "@/server/scoring/signals";

/**
 * Testes do motor de score.
 *
 * O foco e proteger as REGRAS DE PRODUTO que, se quebradas, fazem a IA
 * mentir para o vendedor: classificar por palavra solta, ignorar
 * desqualificadores, ou confundir score com confianca.
 */

const NOW = new Date("2026-09-14T12:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 36e5).toISOString();
}

let seq = 0;
function msg(
  text: string,
  direction: "INBOUND" | "OUTBOUND" = "INBOUND",
  hours = 2,
): MessageSnapshot {
  seq += 1;
  return {
    id: `m${seq}`,
    sessionId: "s1",
    direction,
    text,
    sentAt: hoursAgo(hours),
  };
}

function conversation(messages: MessageSnapshot[]): ConversationSnapshot {
  const last = messages[messages.length - 1];
  return {
    id: "s1",
    accountId: "acc1",
    contactId: "c1",
    channel: "WHATSAPP",
    agentId: "u1",
    agentName: "Vendedor",
    status: "OPEN",
    startedAt: messages[0]?.sentAt ?? hoursAgo(48),
    lastMessageAt: last?.sentAt ?? hoursAgo(2),
    messages,
  };
}

const FULL_DATA = {
  hasName: true,
  hasPhone: true,
  hasCompany: true,
  hasEmail: true,
  hasAgent: true,
};

function score(messages: MessageSnapshot[], dataQuality = FULL_DATA, previous = 0) {
  return computeScore(
    { conversation: conversation(messages), previousConversationCount: previous, now: NOW },
    dataQuality,
  );
}

/* ==========================================================================
   Deteccao de sinais
   ========================================================================== */
describe("detectSignals", () => {
  it("identifica solicitacao de preco com contexto", () => {
    const signals = detectSignals([
      msg("Bom dia! Gostaria de um orcamento para 500 metros de cabo flexivel."),
    ]);
    assert.ok(signals.some((s) => s.code === "SOLICITACAO_PRECO"));
  });

  it("NAO dispara sinal positivo quando a frase e negada", () => {
    const signals = detectSignals([
      msg("Obrigado, mas nao quero orcamento agora."),
    ]);
    const positives = signals.filter((s) => s.polarity === "POSITIVE");
    assert.equal(positives.length, 0, "negacao explicita nao pode virar oportunidade");
  });

  it("identifica desqualificadores de suporte", () => {
    const signals = detectSignals([
      msg("O sistema parou de funcionar, aparece um erro ao acessar o painel."),
    ]);
    assert.ok(signals.some((s) => s.code === "SUPORTE_APENAS"));
  });

  it("registra o trecho literal como evidencia", () => {
    const texto = "Preciso comprar 200 unidades urgente, o orcamento ja foi aprovado.";
    const signals = detectSignals([msg(texto)]);
    const evidencia = signals.find((s) => s.code === "ORCAMENTO_APROVADO");

    assert.ok(evidencia, "sinal deveria existir");
    assert.ok(
      texto.includes(evidencia.excerpt.replace(/^\.\.\.|\.\.\.$/g, "")),
      "a evidencia precisa ser um trecho real da conversa",
    );
  });

  it("atribui forca menor a mensagens curtas sem contexto", () => {
    const curta = detectSignals([msg("quanto custa?")]);
    const longa = detectSignals([
      msg("Bom dia, quanto custa o sistema completo de embalagem industrial para nossa fabrica de alimentos? Precisamos instalar ate o fim do mes."),
    ]);

    const forcaCurta = curta.find((s) => s.code === "SOLICITACAO_PRECO")?.strength ?? 0;
    const forcaLonga = longa.find((s) => s.code === "SOLICITACAO_PRECO")?.strength ?? 0;

    assert.ok(forcaCurta < forcaLonga, "mensagem sem contexto deve valer menos");
  });

  it("reconhece proposta enviada apenas em mensagem de saida", () => {
    const saida = detectSignals([
      msg("Segue a proposta comercial em anexo, valor total de R$ 50.000,00.", "OUTBOUND"),
    ]);
    assert.ok(saida.some((s) => s.code === "PROPOSTA_ENVIADA"));

    const entrada = detectSignals([
      msg("Segue a proposta comercial em anexo.", "INBOUND"),
    ]);
    assert.ok(
      !entrada.some((s) => s.code === "PROPOSTA_ENVIADA"),
      "proposta e enviada pela equipe, nao pelo cliente",
    );
  });
});

/* ==========================================================================
   Regra central: nunca classificar por palavra isolada
   ========================================================================== */
describe("regra de contexto", () => {
  it("mantem 'quanto custa?' isolado abaixo do corte de exibicao", () => {
    const resultado = score([msg("quanto custa?")], {
      hasName: true,
      hasPhone: true,
      hasCompany: false,
      hasEmail: false,
      hasAgent: false,
    });

    assert.ok(
      resultado.score < SCORE_DISPLAY_THRESHOLD,
      `palavra isolada nao pode virar oportunidade (score foi ${resultado.score})`,
    );
    assert.equal(resultado.belowThreshold, true);
  });

  it("aceita a mesma intencao quando ha contexto real", () => {
    const resultado = score([
      msg("Bom dia! Precisamos comprar 400 metros de cabo flexivel 4mm para a obra."),
      msg("Bom dia! Vou levantar o valor.", "OUTBOUND", 1.5),
      msg("O orcamento ja foi aprovado pela diretoria. Preciso fechar ate sexta. Qual a forma de pagamento?", "INBOUND", 1),
    ]);

    assert.ok(resultado.score >= 50, `esperava score relevante, veio ${resultado.score}`);
    assert.equal(resultado.belowThreshold, false);
  });

  it("reduz o score quando so ha sinais fracos", () => {
    const fraco = score([msg("Voces tem esse produto disponivel em estoque?")]);
    const forte = score([
      msg("Preciso comprar 50 unidades, o orcamento ja foi aprovado e quero fechar essa semana."),
    ]);
    assert.ok(fraco.score < forte.score);
  });
});

/* ==========================================================================
   Desqualificadores
   ========================================================================== */
describe("desqualificadores", () => {
  it("zera o score quando a compra ja foi concluida", () => {
    const resultado = score([
      msg("Queria saber o valor do pacote anual."),
      msg("Perfeito, ja fechei com voces pelo portal. Pedido confirmado!", "INBOUND", 1),
    ]);

    assert.equal(resultado.score, 0, "compra concluida nao e oportunidade aberta");
    assert.ok(resultado.disqualifiers.some((s) => s.code === "COMPRA_CONCLUIDA"));
  });

  it("zera o score em pedido de descadastro", () => {
    const resultado = score([msg("Nao quero mais receber mensagens, me remova da lista.")]);
    assert.equal(resultado.score, 0);
  });

  it("mantem atendimento de suporte puro fora do corte", () => {
    const resultado = score([
      msg("O equipamento parou de funcionar depois da atualizacao, aparece um erro."),
      msg("Preciso resolver, a producao esta parada.", "INBOUND", 1),
    ]);
    assert.ok(resultado.score < SCORE_DISPLAY_THRESHOLD);
  });

  it("explica a desqualificacao no rationale", () => {
    const resultado = score([msg("Ja comprei com voces, obrigado.")]);
    assert.ok(
      resultado.rationale.some((r) => /desqualificada/i.test(r)),
      "o motivo precisa estar visivel para o usuario",
    );
  });
});

/* ==========================================================================
   Score x confianca sao medidas diferentes
   ========================================================================== */
describe("score e confianca", () => {
  it("confianca cai quando faltam dados cadastrais", () => {
    const messages = [
      msg("Preciso comprar 100 unidades do produto, orcamento aprovado, fechar essa semana."),
    ];

    const completo = score(messages, FULL_DATA);
    const incompleto = score(messages, {
      hasName: true,
      hasPhone: false,
      hasCompany: false,
      hasEmail: false,
      hasAgent: false,
    });

    assert.ok(
      incompleto.confidence < completo.confidence,
      "menos dados = menos confianca",
    );
  });

  it("uma oportunidade desqualificada ainda pode ter confianca alta", () => {
    // O score cai a zero, mas a evidencia de que NAO e oportunidade e solida.
    const resultado = score([
      msg("Queria saber o valor do pacote de manutencao anual dos equipamentos."),
      msg("Perfeito, ja fechei com voces pelo portal. Pedido confirmado, obrigado!", "INBOUND", 1),
    ]);

    assert.equal(resultado.score, 0);
    assert.ok(
      resultado.confidence > 30,
      "confianca mede evidencia, nao potencial de venda",
    );
  });

  it("nunca produz valores fora de 0-100", () => {
    const casos = [
      [msg("oi")],
      [msg("Preciso comprar urgente, orcamento aprovado, quero fechar hoje, qual o desconto?")],
      [msg("spam ganhe dinheiro clique aqui agora")],
    ];

    for (const messages of casos) {
      const r = score(messages);
      assert.ok(r.score >= 0 && r.score <= 100, `score fora da faixa: ${r.score}`);
      assert.ok(r.confidence >= 0 && r.confidence <= 100, `confianca fora da faixa: ${r.confidence}`);
    }
  });
});

/* ==========================================================================
   Composicao do score
   ========================================================================== */
describe("composicao do score", () => {
  it("respeita o teto de cada dimensao", () => {
    const r = score([
      msg("Preciso comprar 500 unidades, orcamento ja aprovado pela diretoria, fechar ate sexta, qual desconto e forma de pagamento?"),
    ], FULL_DATA, 8);

    const tetos = {
      intencaoExplicita: 30,
      recencia: 15,
      clarezaNecessidade: 15,
      maturidadeComercial: 15,
      proximoPasso: 10,
      relacionamento: 10,
      qualidadeDados: 5,
    } as const;

    for (const [chave, teto] of Object.entries(tetos)) {
      const valor = r.breakdown[chave as keyof typeof tetos];
      assert.ok(valor <= teto + 1e-9, `${chave} estourou o teto: ${valor} > ${teto}`);
      assert.ok(valor >= 0, `${chave} ficou negativo: ${valor}`);
    }
  });

  it("recencia zera apos 45 dias", () => {
    const antiga = conversation([msg("Preciso comprar 100 unidades urgente.")]);
    antiga.lastMessageAt = new Date(NOW.getTime() - 60 * 24 * 36e5).toISOString();

    const r = computeScore(
      { conversation: antiga, previousConversationCount: 0, now: NOW },
      FULL_DATA,
    );
    assert.equal(r.breakdown.recencia, 0);
  });
});

/* ==========================================================================
   Prioridade
   ========================================================================== */
describe("classifyPriority", () => {
  it("segue as faixas definidas no produto", () => {
    assert.equal(classifyPriority(80, 1), "ALTA");
    assert.equal(classifyPriority(60, 1), "MEDIA");
    assert.equal(classifyPriority(35, 1), "BAIXA");
  });

  it("eleva alta prioridade a critica apos 48h sem retorno", () => {
    assert.equal(classifyPriority(80, 72), "CRITICA");
    assert.equal(classifyPriority(80, 10), "ALTA");
  });

  it("nao eleva prioridade media a critica", () => {
    assert.equal(classifyPriority(60, 200), "MEDIA");
  });
});

/* ==========================================================================
   Objecoes
   ========================================================================== */
describe("detectObjections", () => {
  it("identifica objecao de preco e concorrente", () => {
    const objecoes = detectObjections([
      msg("Achei caro, esta acima do nosso orcamento. Estou cotando com outro fornecedor."),
    ]);
    assert.ok(objecoes.includes("Preco acima do esperado"));
    assert.ok(objecoes.includes("Comparando com concorrente"));
  });

  it("ignora objecoes vindas da propria equipe", () => {
    const objecoes = detectObjections([
      msg("Entendo que possa parecer caro, mas o custo-beneficio compensa.", "OUTBOUND"),
    ]);
    assert.equal(objecoes.length, 0);
  });
});
