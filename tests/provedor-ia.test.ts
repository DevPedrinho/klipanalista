import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analisarConversa } from "@/server/ai/opportunity-analyst";
import {
  AiIndisponivelError,
  comReserva,
  ehProvedor,
  type Analista,
  type PedidoDeAnalise,
  type RespostaDoAnalista,
} from "@/server/ai/provedor";
import type { ConversationSnapshot, MessageSnapshot } from "@/domain/types";

/**
 * Troca de provedor de IA.
 *
 * O que estes testes protegem não é a chamada ao SDK — é a afirmação que
 * sustenta a troca: **a garantia do módulo não vem do modelo**. Nenhuma
 * afirmação é aceita sem um trecho literal que exista mesmo na conversa, e
 * essa conferência roda depois do modelo, olhando só o objeto convertido e as
 * mensagens reais.
 *
 * Se isso for verdade, a mesma saída inventada tem que ser descartada venha
 * de onde vier. É exatamente o que se testa aqui, com analistas de mentira.
 */

function msg(id: string, text: string, direction: "INBOUND" | "OUTBOUND" = "INBOUND"): MessageSnapshot {
  return { id, sessionId: "s1", direction, text, sentAt: "2026-09-16T18:25:43.000Z" };
}

const CONVERSA: ConversationSnapshot = {
  id: "s1",
  accountId: "klipflowi",
  contactId: "c1",
  channel: "WHATSAPP",
  status: "OPEN",
  startedAt: "2026-09-16T18:25:43.000Z",
  lastMessageAt: "2026-09-16T18:40:00.000Z",
  messages: [
    msg("m1", "Boa tarde, eu queria um orçamento para um computador"),
    msg("m2", "O orçamento já foi aprovado aqui pela diretoria"),
  ],
};

/** Saída válida, com um sinal cujo trecho EXISTE na conversa. */
function saidaHonesta() {
  return {
    icp: {
      fitDeNecessidade: { nota: 20, justificativa: "quer computador", trecho: null },
      poderDeDecisao: { nota: 15, justificativa: "decide", trecho: null },
      orcamento: { nota: 15, justificativa: "aprovado", trecho: null },
      prazo: { nota: 10, justificativa: "sem data", trecho: null },
      engajamento: { nota: 10, justificativa: "responde", trecho: null },
      perfilResumido: "cliente de teste",
    },
    temSinalComercial: true,
    resumoDaNecessidade: "Quer comprar um computador.",
    produtoDeInteresse: "computador",
    sinais: [
      {
        codigo: "ORCAMENTO_APROVADO",
        trecho: "O orçamento já foi aprovado aqui pela diretoria",
        quemDisse: "CLIENTE" as const,
        forca: 0.9,
      },
    ],
    objecoes: [],
    proximoPasso: "Enviar a proposta hoje.",
    valorMencionado: null,
    justificativa: "Teste.",
  };
}

/** A mesma saída, mas citando uma frase que ninguém disse. */
function saidaInventada() {
  const base = saidaHonesta();
  return {
    ...base,
    sinais: [{ ...base.sinais[0]!, trecho: "Pode faturar, fechamos hoje mesmo" }],
  };
}

function analistaFalso(
  provedor: "anthropic" | "openai",
  saida: unknown,
  modelo = "modelo-de-teste",
): Analista {
  return {
    provedor,
    modelo,
    async analisar(_pedido: PedidoDeAnalise): Promise<RespostaDoAnalista> {
      return { saida, provedor, modelo };
    },
  };
}

describe("a garantia não vem do modelo", () => {
  it("aceita o sinal cujo trecho existe, venha do provedor que vier", async () => {
    for (const provedor of ["anthropic", "openai"] as const) {
      const resultado = await analisarConversa({
        conversation: CONVERSA,
        contactName: "Cristiano",
        analista: analistaFalso(provedor, saidaHonesta()),
      });

      assert.equal(resultado?.sinais.length, 1, `falhou em ${provedor}`);
      assert.equal(resultado?.provedor, provedor, "o resultado diz quem leu");
    }
  });

  /**
   * O caso que justifica o módulo inteiro. Uma frase perfeitamente plausível
   * que ninguém disse é pior que nenhuma análise — o time age em cima dela.
   */
  it("descarta a invenção igualmente nos dois provedores", async () => {
    for (const provedor of ["anthropic", "openai"] as const) {
      const resultado = await analisarConversa({
        conversation: CONVERSA,
        contactName: "Cristiano",
        analista: analistaFalso(provedor, saidaInventada()),
      });

      assert.deepEqual(resultado?.sinais, [], `${provedor} deixou passar`);
      assert.equal(resultado?.descartados.length, 1, `${provedor} não registrou o descarte`);
    }
  });

  /**
   * Cada SDK converte do seu jeito. Revalidar contra o mesmo schema faz toda
   * resposta entrar pela mesma porta — sem isso, a garantia dependeria de
   * qual provedor atendeu.
   */
  it("recusa saída fora do formato, em vez de confiar na conversão do SDK", async () => {
    const resultado = await analisarConversa({
      conversation: CONVERSA,
      contactName: "Cristiano",
      analista: analistaFalso("openai", { qualquer: "coisa" }),
    });

    assert.equal(resultado, null);
  });

  it("registra qual modelo leu, para comparar custo por análise aproveitada", async () => {
    const resultado = await analisarConversa({
      conversation: CONVERSA,
      contactName: "Cristiano",
      analista: analistaFalso("openai", saidaHonesta(), "gpt-barato"),
    });

    assert.equal(resultado?.modelo, "gpt-barato");
  });
});

describe("queda para o provedor reserva", () => {
  function analistaQueRecusa(provedor: "anthropic" | "openai"): Analista {
    return {
      provedor,
      modelo: "indisponivel",
      async analisar() {
        throw new AiIndisponivelError(provedor, "Crédito no fim.");
      },
    };
  }

  it("cai para o reserva quando o principal fica indisponível", async () => {
    const analista = comReserva(
      analistaQueRecusa("anthropic"),
      analistaFalso("openai", saidaHonesta(), "gpt-reserva"),
    );

    const resposta = await analista.analisar({
      sistema: "s",
      usuario: "u",
      schema: { parse: (v: unknown) => v } as never,
      esforco: "low",
    });

    assert.equal(resposta.provedor, "openai");
    assert.equal(resposta.modelo, "gpt-reserva", "a troca precisa aparecer");
  });

  /**
   * Erro de formato é problema de conteúdo, não de disponibilidade. Tentar o
   * outro provedor não consertaria e gastaria dinheiro duas vezes.
   */
  it("não cai para o reserva em erro que não é de disponibilidade", async () => {
    let reservaChamado = false;

    const reserva: Analista = {
      provedor: "openai",
      modelo: "gpt",
      async analisar() {
        reservaChamado = true;
        return { saida: {}, provedor: "openai", modelo: "gpt" };
      },
    };

    const principal: Analista = {
      provedor: "anthropic",
      modelo: "claude",
      async analisar() {
        throw new TypeError("resposta em formato inesperado");
      },
    };

    await assert.rejects(
      () =>
        comReserva(principal, reserva).analisar({
          sistema: "s",
          usuario: "u",
          schema: { parse: (v: unknown) => v } as never,
          esforco: "low",
        }),
      TypeError,
    );

    assert.equal(reservaChamado, false, "gastar no segundo provedor não ajudaria");
  });

  /**
   * O prazo estourou, não o provedor. Tentar o reserva consumiria um
   * orçamento que já acabou.
   */
  it("não cai para o reserva quando a análise foi interrompida por tempo", async () => {
    let reservaChamado = false;

    const reserva: Analista = {
      provedor: "openai",
      modelo: "gpt",
      async analisar() {
        reservaChamado = true;
        return { saida: {}, provedor: "openai", modelo: "gpt" };
      },
    };

    const controle = new AbortController();
    controle.abort();

    await assert.rejects(
      () =>
        comReserva(analistaQueRecusa("anthropic"), reserva).analisar({
          sistema: "s",
          usuario: "u",
          schema: { parse: (v: unknown) => v } as never,
          esforco: "low",
          signal: controle.signal,
        }),
      AiIndisponivelError,
    );

    assert.equal(reservaChamado, false);
  });

  it("sem reserva configurado, o principal responde sozinho", async () => {
    const analista = comReserva(analistaFalso("anthropic", saidaHonesta()));

    const resposta = await analista.analisar({
      sistema: "s",
      usuario: "u",
      schema: { parse: (v: unknown) => v } as never,
      esforco: "low",
    });

    assert.equal(resposta.provedor, "anthropic");
  });
});

describe("nomes de provedor", () => {
  it("reconhece os dois e recusa o resto", () => {
    assert.equal(ehProvedor("anthropic"), true);
    assert.equal(ehProvedor("openai"), true);
    assert.equal(ehProvedor("gemini"), false, "ainda não existe provedor para ele");
    assert.equal(ehProvedor(""), false);
  });
});
