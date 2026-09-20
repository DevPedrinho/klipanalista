import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  identidadeProvisoria,
  normalizarPlanilha,
} from "@/server/import/normalizar";
import type { Mapeamento } from "@/server/import/mapeamento";
import type { LinhaDaPlanilha } from "@/server/import/xlsx-reader";

/**
 * Da planilha para a conversa.
 *
 * Depois desta função não há mais nada de planilha: sai o mesmo
 * `ConversationSnapshot` que os adapters produzem da API. O risco aqui não é
 * rejeitar linha ruim — é rejeitar em silêncio. Um mapeamento errado pode
 * descartar metade do relatório, e a tela mostraria "12 oportunidades" com a
 * mesma cara de quem analisou tudo.
 */

const COLUNAS = ["Atendimento", "Data", "Direção", "Mensagem", "Contato", "Telefone", "Nome"];

const MAPEAMENTO: Mapeamento = {
  sessionId: "Atendimento",
  dataHora: "Data",
  direcao: "Direção",
  texto: "Mensagem",
  contatoId: "Contato",
  telefone: "Telefone",
  contatoNome: "Nome",
};

const DIRECOES = { Recebida: "INBOUND", Enviada: "OUTBOUND" } as const;

const SESSAO = "b574cc56-1d90-4792-8f74-7d03204d9f67";
const CONTATO = "52499961-399e-4a1a-b58a-dd4c8ce6b159";

function linha(numero: number, valores: Partial<Record<string, string>>): LinhaDaPlanilha {
  const completos: Record<string, string> = {};
  for (const c of COLUNAS) completos[c] = valores[c] ?? "";
  return { numero, valores: completos };
}

function normalizar(linhas: LinhaDaPlanilha[]) {
  return normalizarPlanilha(linhas, {
    accountId: "klipflowi",
    mapeamento: MAPEAMENTO,
    direcoes: { ...DIRECOES },
  });
}

describe("normalizar a planilha", () => {
  it("agrupa as linhas de um atendimento numa conversa só", () => {
    const resultado = normalizar([
      linha(2, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "Boa tarde, preciso comprar um computador",
        Contato: CONTATO,
        Nome: "Cristiano Silva",
      }),
      linha(3, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:26:10.000Z",
        Direção: "Enviada",
        Mensagem: "Boa tarde! Como posso ajudar?",
        Contato: CONTATO,
      }),
    ]);

    assert.equal(resultado.conversas.length, 1);
    assert.equal(resultado.mensagens, 2);

    const conversa = resultado.conversas[0];
    assert.equal(conversa?.id, SESSAO);
    assert.equal(conversa?.contactId, CONTATO);
    assert.equal(conversa?.messages[0]?.direction, "INBOUND");
    assert.equal(conversa?.messages[1]?.direction, "OUTBOUND");
    assert.equal(resultado.contatos[0]?.name, "Cristiano Silva");
  });

  /**
   * A ordem da planilha não é garantida, e a análise inteira depende da
   * cronologia: recência, quem falou por último, quanto tempo sem resposta.
   */
  it("ordena as mensagens por data, não pela ordem do arquivo", () => {
    const resultado = normalizar([
      linha(2, {
        Atendimento: SESSAO,
        Data: "2026-09-17T13:43:36.000Z",
        Direção: "Recebida",
        Mensagem: "a última",
      }),
      linha(3, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "a primeira",
      }),
    ]);

    const conversa = resultado.conversas[0];
    assert.equal(conversa?.messages[0]?.text, "a primeira");
    assert.equal(conversa?.messages[1]?.text, "a última");
    assert.equal(conversa?.startedAt, "2026-09-16T18:25:43.000Z");
    assert.equal(conversa?.lastMessageAt, "2026-09-17T13:43:36.000Z");
  });

  it("guarda a linha da planilha no id da mensagem, para conferir depois", () => {
    const resultado = normalizar([
      linha(42, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "quero um orçamento",
      }),
    ]);

    assert.equal(resultado.conversas[0]?.messages[0]?.id, "linha-42");
  });
});

describe("o que é recusado, e dito em voz alta", () => {
  it("recusa linha sem data, sem direção ou sem texto, agrupando por motivo", () => {
    const resultado = normalizar([
      linha(2, { Atendimento: SESSAO, Data: "não é data", Direção: "Recebida", Mensagem: "oi" }),
      linha(3, { Atendimento: SESSAO, Data: "ontem", Direção: "Recebida", Mensagem: "oi" }),
      linha(4, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Nota interna",
        Mensagem: "oi",
      }),
      linha(5, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "",
      }),
      linha(6, { Data: "2026-09-16T18:25:43.000Z", Direção: "Recebida", Mensagem: "oi" }),
    ]);

    assert.equal(resultado.conversas.length, 0, "nenhuma linha válida sobrou");

    const motivos = resultado.rejeicoes;
    assert.ok(motivos.some((r) => /Data ilegivel/.test(r.motivo) && r.quantidade === 2));
    assert.ok(motivos.some((r) => /Direcao nao reconhecida/.test(r.motivo)));
    assert.ok(motivos.some((r) => /Sem texto/.test(r.motivo)));
    assert.ok(motivos.some((r) => /Sem identificador/.test(r.motivo)));
  });

  /**
   * A lição do MappingReport: repetir a mesma frase 500 vezes produziu uma
   * resposta de 260 KB e nenhuma informação a mais.
   */
  it("não repete o mesmo motivo mil vezes — agrupa e dá exemplos", () => {
    const muitas = Array.from({ length: 300 }, (_, i) =>
      linha(i + 2, {
        Atendimento: SESSAO,
        Data: "data inválida",
        Direção: "Recebida",
        Mensagem: "oi",
      }),
    );

    const resultado = normalizar(muitas);

    assert.equal(resultado.rejeicoes.length, 1, "um motivo, não trezentos");
    assert.equal(resultado.rejeicoes[0]?.quantidade, 300);
    assert.ok(
      (resultado.rejeicoes[0]?.exemplos.length ?? 0) <= 5,
      "poucos exemplos bastam para conferir na planilha",
    );
  });

  /**
   * O agrupamento tem que sobreviver a valores DIFERENTES.
   *
   * Colar o valor dentro do motivo — "Data ilegível: ontem" — parece
   * informativo e desfaz o agrupamento em silêncio: trezentas datas ruins
   * distintas voltam como trezentos motivos, que é exatamente o problema que
   * o agrupamento existe para resolver. O valor vai numa amostra à parte.
   */
  it("agrupa mesmo quando cada linha erra de um jeito diferente", () => {
    const variadas = Array.from({ length: 50 }, (_, i) =>
      linha(i + 2, {
        Atendimento: SESSAO,
        Data: `data inválida número ${i}`,
        Direção: "Recebida",
        Mensagem: "oi",
      }),
    );

    const resultado = normalizar(variadas);

    assert.equal(resultado.rejeicoes.length, 1, "cinquenta valores, um motivo só");
    assert.equal(resultado.rejeicoes[0]?.quantidade, 50);
    assert.ok(
      (resultado.rejeicoes[0]?.amostraDeValores.length ?? 0) <= 3,
      "uma amostra dos valores basta para entender o que está errado",
    );
    assert.ok(
      (resultado.rejeicoes[0]?.amostraDeValores.length ?? 0) > 0,
      "sem nenhum exemplo de valor ninguém descobre o formato esperado",
    );
  });

  it("recusa tudo quando o mapeamento não tem os campos obrigatórios", () => {
    const resultado = normalizarPlanilha(
      [linha(2, { Atendimento: SESSAO, Mensagem: "oi" })],
      {
        accountId: "klipflowi",
        mapeamento: { sessionId: "Atendimento", texto: "Mensagem" },
        direcoes: {},
      },
    );

    assert.equal(resultado.conversas.length, 0);
    assert.match(resultado.rejeicoes[0]?.motivo ?? "", /mapeamento/i);
  });
});

describe("identidade do contato", () => {
  it("usa o telefone quando o relatório não traz o id, e marca como provisória", () => {
    const resultado = normalizar([
      linha(2, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "quero um orçamento para um PC",
        Telefone: "(85) 99999-9962",
      }),
    ]);

    const contactId = resultado.conversas[0]?.contactId ?? "";

    assert.ok(identidadeProvisoria(contactId), `deveria ser provisória: ${contactId}`);
    assert.match(contactId, /85999999962$/, "os dígitos do telefone identificam");
    assert.ok(
      resultado.avisos.some((a) => /TELEFONE/.test(a)),
      "a tela precisa saber que não dá para escrever direto",
    );
    assert.equal(resultado.contatos[0]?.phone, "(85) 99999-9962");
  });

  it("o id real da plataforma vence o telefone", () => {
    const resultado = normalizar([
      linha(2, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "quero um orçamento",
        Contato: CONTATO,
        Telefone: "(85) 99999-9962",
      }),
    ]);

    const contactId = resultado.conversas[0]?.contactId ?? "";
    assert.equal(contactId, CONTATO);
    assert.equal(identidadeProvisoria(contactId), false);
  });

  it("avisa quando não há id nem telefone", () => {
    const resultado = normalizar([
      linha(2, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "quero um orçamento",
      }),
    ]);

    assert.equal(resultado.conversas[0]?.contactId, "");
    assert.ok(resultado.avisos.some((a) => /sem telefone/.test(a)));
  });

  it("avisa quando nenhuma coluna de atendente foi mapeada", () => {
    const resultado = normalizar([
      linha(2, {
        Atendimento: SESSAO,
        Data: "2026-09-16T18:25:43.000Z",
        Direção: "Recebida",
        Mensagem: "quero um orçamento",
      }),
    ]);

    assert.ok(resultado.avisos.some((a) => /qualidade por/.test(a)));
  });
});
