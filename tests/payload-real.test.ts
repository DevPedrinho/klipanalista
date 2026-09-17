import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MappingReport } from "@/server/integration/mappers/tolerant";
import { mapAgent } from "@/server/integration/adapters/agents.adapter";
import { mapPanel } from "@/server/integration/adapters/panels.adapter";
import { mapSession } from "@/server/integration/adapters/sessions.adapter";

/**
 * Contrato dos payloads REAIS da API KlipFlowi.
 *
 * Os nomes de campo abaixo nao sao suposicao: foram lidos da conta de
 * verdade por GET /api/health/probe. Os VALORES sao sinteticos — nenhum dado
 * de cliente entra em teste.
 *
 * O motivo de existirem: todo defeito que a sonda encontrou era silencioso.
 * Um campo com o nome errado nao gera erro, gera resposta plausivel e errada
 * — um gestor vendo menos do que deveria, uma conversa parada parecendo
 * recente. Testes de payload sao a unica barreira contra esse tipo de
 * regressao, porque nao existe tipo em tempo de compilacao para JSON alheio.
 */

const CONTA = "acc_teste";

describe("payload real de /core/v1/agent", () => {
  /** Campos exatamente como a API devolve. */
  const AGENTE_REAL = {
    availability: "OFFLINE",
    companyId: "comp_1",
    createdAt: "2026-01-10T12:00:00Z",
    departments: [
      { id: "dep_vendas", name: "Comercial" },
      { id: "dep_suporte", name: "Suporte" },
    ],
    email: "fulano@exemplo.com",
    id: "agent_1",
    isOwner: false,
    name: "Fulano de Tal",
    phoneNumber: "5511999999999",
    phoneNumberFormatted: "+55 11 99999-9999",
    profile: "AGENT",
    shortName: "Fulano",
    updatedAt: "2026-02-01T12:00:00Z",
    userId: "user_1",
  };

  it("le a equipe de `departments`, que e uma LISTA", () => {
    const user = mapAgent(AGENTE_REAL, CONTA, new MappingReport());

    assert.ok(user);
    assert.equal(user.teamId, "dep_vendas", "a equipe principal e a primeira da lista");
    assert.deepEqual(user.teamIds, ["dep_vendas", "dep_suporte"]);
    assert.equal(user.teamName, "Comercial");
  });

  it("le o perfil de `profile`: AGENT vira VENDEDOR", () => {
    const user = mapAgent(AGENTE_REAL, CONTA, new MappingReport());
    assert.equal(user?.role, "VENDEDOR");
  });

  it("le ADMIN de `profile`", () => {
    const user = mapAgent({ ...AGENTE_REAL, profile: "ADMIN" }, CONTA, new MappingReport());
    assert.equal(user?.role, "ADMIN");
  });

  it("trata o dono da conta (`isOwner`) como ADMIN", () => {
    const user = mapAgent(
      { ...AGENTE_REAL, profile: "AGENT", isOwner: true },
      CONTA,
      new MappingReport(),
    );
    assert.equal(user?.role, "ADMIN", "`isOwner` e o campo real; `isAdmin` nao existe");
  });

  it("nao promove ninguem por um perfil desconhecido", () => {
    const user = mapAgent(
      { ...AGENTE_REAL, profile: "ALGUM_PERFIL_NOVO" },
      CONTA,
      new MappingReport(),
    );
    assert.equal(user?.role, "VENDEDOR", "perfil desconhecido cai no MENOS privilegiado");
  });

  it("aceita usuario sem nenhuma equipe sem quebrar", () => {
    const user = mapAgent({ ...AGENTE_REAL, departments: [] }, CONTA, new MappingReport());
    assert.equal(user?.teamId, undefined);
    assert.deepEqual(user?.teamIds, []);
  });
});

describe("payload real de /chat/v2/session", () => {
  const SESSAO_REAL = {
    agentDetails: { id: "agent_1", name: "Fulano de Tal" },
    channelType: "WHATSAPP",
    companyId: "comp_1",
    contactId: "contact_1",
    createdAt: "2026-03-01T09:00:00Z",
    firstResponseAt: "2026-03-01T09:05:00Z",
    id: "sess_1",
    lastInteractionDate: "2026-03-02T15:00:00Z",
    lastMessageIn: "2026-03-02T15:00:00Z",
    lastMessageOut: "2026-03-01T10:00:00Z",
    lastMessageText: "combinado",
    previewUrl: "https://app.exemplo.com/chat2/sessions/sess_1/preview",
    startAt: "2026-03-01T09:01:00Z",
    status: "OPEN",
    timeService: 3600,
    timeWait: 300,
    updatedAt: "2026-04-20T23:59:00Z",
    userId: "agent_1",
  };

  /**
   * A regressao mais cara do modulo: enquanto o mapeador caia em `updatedAt`,
   * uma conversa parada desde marco parecia ter tido interacao em abril. A
   * pontuacao de recencia subia e a oportunidade esquecida — exatamente o que
   * este modulo existe para achar — sumia da lista.
   */
  it("le a recencia de `lastInteractionDate`, nunca de `updatedAt`", () => {
    const sessao = mapSession(SESSAO_REAL, CONTA, new MappingReport());

    assert.ok(sessao);
    assert.equal(Date.parse(sessao.lastMessageAt), Date.parse("2026-03-02T15:00:00Z"));
    assert.notEqual(
      Date.parse(sessao.lastMessageAt),
      Date.parse(SESSAO_REAL.updatedAt),
      "`updatedAt` muda com qualquer alteracao da conversa, nao so com mensagem",
    );
  });

  it("le o atendente de `userId` e o nome de `agentDetails`", () => {
    const sessao = mapSession(SESSAO_REAL, CONTA, new MappingReport());
    assert.equal(sessao?.agentId, "agent_1");
    assert.equal(sessao?.agentName, "Fulano de Tal");
  });

  it("aproveita os tempos que a propria listagem ja traz", () => {
    const sessao = mapSession(SESSAO_REAL, CONTA, new MappingReport());

    assert.equal(sessao?.waitSeconds, 300);
    assert.equal(sessao?.serviceSeconds, 3600);
    assert.ok(sessao?.firstResponseAt, "o primeiro retorno vem pronto da API");
    assert.ok(sessao?.lastInboundAt, "ultima mensagem do cliente");
    assert.ok(sessao?.lastOutboundAt, "ultima mensagem enviada");
    assert.ok(sessao?.previewUrl, "a API ja devolve o link do atendimento");
  });

  it("usa `startAt` como inicio do atendimento", () => {
    const sessao = mapSession(SESSAO_REAL, CONTA, new MappingReport());
    assert.equal(Date.parse(sessao!.startedAt), Date.parse("2026-03-01T09:01:00Z"));
  });
});

describe("payload real de /crm/v2/panel", () => {
  const base = {
    archived: false,
    companyId: "comp_1",
    id: "panel_1",
    steps: [],
    title: "Prospeccao Ativa",
  };

  it("reconhece SALES e MANAGEMENT", () => {
    assert.equal(mapPanel({ ...base, type: "SALES" }, CONTA, new MappingReport())?.type, "SALES");
    assert.equal(
      mapPanel({ ...base, type: "MANAGEMENT" }, CONTA, new MappingReport())?.type,
      "MANAGEMENT",
    );
  });

  /**
   * A direcao do padrao importa. Um painel tratado como SALES por engano
   * vira destino de card sugerido: a IA proporia registrar uma venda dentro
   * do quadro de tarefas de alguem. Na conta real, 18 dos 20 paineis sao
   * exatamente isso.
   */
  it("trata tipo desconhecido como MANAGEMENT, nunca como SALES", () => {
    for (const tipo of ["TASKS", "ALGO_NOVO", "", undefined]) {
      const painel = mapPanel({ ...base, type: tipo }, CONTA, new MappingReport());
      assert.equal(
        painel?.type,
        "MANAGEMENT",
        `tipo "${tipo}" nao pode virar funil de vendas por padrao`,
      );
    }
  });

  it("le o nome do painel de `title`", () => {
    const painel = mapPanel({ ...base, type: "SALES" }, CONTA, new MappingReport());
    assert.equal(painel?.name, "Prospeccao Ativa");
  });

  it("ordena as etapas do detalhe pela ordem declarada", () => {
    const detalhe = {
      ...base,
      type: "SALES",
      steps: [
        { id: "s2", title: "Visita", order: 2 },
        { id: "s1", title: "Proposta Quente", order: 1 },
        { id: "s3", title: "Ordem de Compra", order: 3 },
      ],
    };

    const painel = mapPanel(detalhe, CONTA, new MappingReport());
    assert.deepEqual(
      painel?.steps.map((s) => s.name),
      ["Proposta Quente", "Visita", "Ordem de Compra"],
    );
  });
});
