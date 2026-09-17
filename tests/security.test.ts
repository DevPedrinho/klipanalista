import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppUser } from "@/domain/types";
import { maskDeep, maskDocument, maskEmail, maskPhone, scrubSecrets } from "@/server/security/masking";
import {
  AccessError,
  buildTenantContext,
  canApproveActions,
  canEditSettings,
  canSeeAgent,
  filtersSchema,
  resolvePeriod,
  resolveVisibility,
  widgetParamsSchema,
} from "@/server/security/tenant-context";

/**
 * Testes de seguranca, isolamento entre contas e LGPD.
 *
 * O que estes testes impedem: um vendedor enxergar a carteira do colega,
 * um userId trocado na URL virar escalonamento de privilegio, e dados
 * pessoais vazarem para log.
 */

const USERS: AppUser[] = [
  { id: "u_vend_a", accountId: "acc1", name: "Vendedor A", role: "VENDEDOR", teamId: "t1", active: true },
  { id: "u_vend_b", accountId: "acc1", name: "Vendedor B", role: "VENDEDOR", teamId: "t1", active: true },
  { id: "u_vend_c", accountId: "acc1", name: "Vendedor C", role: "VENDEDOR", teamId: "t2", active: true },
  { id: "u_gestor", accountId: "acc1", name: "Gestor T1", role: "GESTOR", teamId: "t1", active: true },
  { id: "u_admin", accountId: "acc1", name: "Admin", role: "ADMIN", active: true },
  { id: "u_inativo", accountId: "acc1", name: "Inativo", role: "GESTOR", teamId: "t1", active: false },
  // Usuario de OUTRA conta, com o mesmo formato de id.
  { id: "u_outro", accountId: "acc2", name: "Outro", role: "ADMIN", active: true },
];

/* ==========================================================================
   Escopo de visibilidade
   ========================================================================== */
describe("resolveVisibility", () => {
  it("vendedor enxerga apenas a si mesmo", () => {
    const user = USERS[0]!;
    assert.deepEqual(resolveVisibility(user, USERS), ["u_vend_a"]);
  });

  it("gestor enxerga a propria equipe", () => {
    const visivel = resolveVisibility(USERS[3]!, USERS);
    assert.ok(Array.isArray(visivel));
    assert.deepEqual([...visivel].sort(), ["u_gestor", "u_inativo", "u_vend_a", "u_vend_b"]);
    assert.ok(!visivel.includes("u_vend_c"), "gestor nao ve outra equipe");
  });

  it("administrador enxerga a conta toda", () => {
    assert.equal(resolveVisibility(USERS[4]!, USERS), "ALL");
  });
});

/* ==========================================================================
   Protecao contra IDOR
   ========================================================================== */
describe("buildTenantContext", () => {
  it("recusa usuario inexistente", () => {
    assert.throws(
      () => buildTenantContext({ accountId: "acc1", userId: "u_fantasma", allUsers: USERS }),
      (e: unknown) => e instanceof AccessError && e.code === "USUARIO_NAO_ENCONTRADO",
    );
  });

  /**
   * Esta e a barreira contra IDOR: trocar o userId na barra de enderecos por
   * um id valido de OUTRA conta nao pode conceder acesso.
   *
   * O codigo distingue este caso de "token recusado" — dizer ao usuario para
   * conferir a credencial quando o problema e o id da URL manda procurar
   * defeito onde nao ha. A recusa em si continua sendo a mesma.
   */
  it("recusa usuario de outra conta mesmo com id valido", () => {
    assert.throws(
      () => buildTenantContext({ accountId: "acc1", userId: "u_outro", allUsers: USERS }),
      (e: unknown) => e instanceof AccessError && e.code === "USUARIO_NAO_ENCONTRADO",
      "id de outra conta nao pode ser aceito",
    );
  });

  it("nao classifica id errado como credencial recusada", () => {
    // Os dois casos pediam a mesma tela, que mandava conferir FLW_API_TOKEN.
    try {
      buildTenantContext({ accountId: "acc1", userId: "u_fantasma", allUsers: USERS });
      assert.fail("deveria ter recusado");
    } catch (erro) {
      assert.ok(erro instanceof AccessError);
      assert.notEqual(
        erro.code,
        "NAO_AUTENTICADO",
        "um userId errado na URL nao e um token invalido",
      );
    }
  });

  it("recusa usuario inativo", () => {
    assert.throws(
      () => buildTenantContext({ accountId: "acc1", userId: "u_inativo", allUsers: USERS }),
      (e: unknown) => e instanceof AccessError && e.code === "SEM_PERMISSAO",
    );
  });

  it("deriva o perfil do cadastro, nunca da requisicao", () => {
    const ctx = buildTenantContext({ accountId: "acc1", userId: "u_vend_a", allUsers: USERS });
    assert.equal(ctx.role, "VENDEDOR");
    assert.deepEqual(ctx.visibleAgentIds, ["u_vend_a"]);
  });

  it("impede vendedor de pedir o recorte de outra equipe", () => {
    assert.throws(
      () =>
        buildTenantContext({
          accountId: "acc1",
          userId: "u_vend_a",
          allUsers: USERS,
          requestedTeamId: "t2",
        }),
      (e: unknown) => e instanceof AccessError && e.code === "SEM_PERMISSAO",
    );
  });

  it("permite ao gestor escolher um recorte de equipe", () => {
    const ctx = buildTenantContext({
      accountId: "acc1",
      userId: "u_gestor",
      allUsers: USERS,
      requestedTeamId: "t1",
    });
    assert.equal(ctx.teamId, "t1");
  });
});

/* ==========================================================================
   canSeeAgent
   ========================================================================== */
describe("canSeeAgent", () => {
  const ctxVendedor = buildTenantContext({
    accountId: "acc1", userId: "u_vend_a", allUsers: USERS,
  });

  it("permite ver o proprio atendimento", () => {
    assert.equal(canSeeAgent(ctxVendedor, "u_vend_a"), true);
  });

  it("nega o atendimento de outro vendedor", () => {
    assert.equal(canSeeAgent(ctxVendedor, "u_vend_b"), false);
  });

  it("permite conversa sem responsavel definido", () => {
    assert.equal(canSeeAgent(ctxVendedor, undefined), true);
  });

  it("administrador ve qualquer atendimento", () => {
    const ctxAdmin = buildTenantContext({
      accountId: "acc1", userId: "u_admin", allUsers: USERS,
    });
    assert.equal(canSeeAgent(ctxAdmin, "u_vend_c"), true);
  });
});

/* ==========================================================================
   Permissoes administrativas
   ========================================================================== */
describe("permissoes administrativas", () => {
  it("somente administrador edita configuracoes", () => {
    assert.equal(canEditSettings("ADMIN"), true);
    assert.equal(canEditSettings("GESTOR"), false);
    assert.equal(canEditSettings("VENDEDOR"), false);
  });

  it("gestor e administrador podem aprovar acoes", () => {
    assert.equal(canApproveActions("ADMIN"), true);
    assert.equal(canApproveActions("GESTOR"), true);
    assert.equal(canApproveActions("VENDEDOR"), false);
  });
});

/* ==========================================================================
   Validacao de parametros da URL
   ========================================================================== */
describe("validacao de parametros", () => {
  const maliciosos = [
    "../../etc/passwd",
    "acc1' OR '1'='1",
    "acc1;DROP TABLE users",
    "<script>alert(1)</script>",
    "acc1/../acc2",
    "acc 1",
    "",
  ];

  for (const valor of maliciosos) {
    it(`recusa accountId ${JSON.stringify(valor)}`, () => {
      const r = filtersSchema.safeParse({ accountId: valor, userId: "u1" });
      assert.equal(r.success, false);
    });
  }

  it("aceita identificadores legitimos", () => {
    const r = filtersSchema.safeParse({ accountId: "acc_klipflowi-01", userId: "user_ana" });
    assert.equal(r.success, true);
  });

  it("recusa origem invalida no widget", () => {
    const r = widgetParamsSchema.safeParse({
      accountId: "acc1", userId: "u1", origin: "financeiro",
    });
    assert.equal(r.success, false);
  });

  it("assume atendimento como origem padrao do widget", () => {
    const r = widgetParamsSchema.safeParse({ accountId: "acc1", userId: "u1" });
    assert.equal(r.success && r.data.origin, "atendimento");
  });
});

/* ==========================================================================
   Periodo
   ========================================================================== */
describe("resolvePeriod", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");

  it("converte presets em janelas corretas", () => {
    for (const [preset, dias] of [["7d", 7], ["15d", 15], ["30d", 30], ["90d", 90]] as const) {
      const p = resolvePeriod({ preset, now });
      const diff = (Date.parse(p.to) - Date.parse(p.from)) / 864e5;
      assert.ok(Math.abs(diff - dias) < 0.01, `${preset} deu ${diff} dias`);
    }
  });

  /**
   * Tres dias, e nao trinta.
   *
   * A API nao aceita filtro de data e entrega a listagem da conversa mais
   * ANTIGA para a mais nova — 22 mil conversas nesta conta. Cada dia a mais
   * no recorte custa paginas lidas de tras para frente, entao o padrao e a
   * janela em que uma oportunidade ainda esta quente.
   */
  it("usa 3 dias como padrao", () => {
    const p = resolvePeriod({ now });
    assert.equal(p.preset, "3d");

    const dias = (Date.parse(p.to) - Date.parse(p.from)) / 864e5;
    assert.ok(Math.abs(dias - 3) < 0.01, `a janela precisa ter 3 dias, tem ${dias}`);
  });

  it("recai no padrao quando custom vem sem datas", () => {
    const p = resolvePeriod({ preset: "custom", now });
    assert.equal(p.preset, "3d");
  });

  it("continua aceitando os periodos maiores quando pedidos", () => {
    for (const [preset, esperado] of [
      ["7d", 7],
      ["15d", 15],
      ["30d", 30],
      ["90d", 90],
    ] as [string, number][]) {
      const p = resolvePeriod({ preset, now });
      const dias = (Date.parse(p.to) - Date.parse(p.from)) / 864e5;
      assert.ok(
        Math.abs(dias - esperado) < 0.01,
        `${preset} deveria cobrir ${esperado} dias, cobriu ${dias}`,
      );
    }
  });
});

/* ==========================================================================
   Mascaramento (LGPD)
   ========================================================================== */
describe("mascaramento de dados pessoais", () => {
  it("preserva o DDD descartando o codigo do pais", () => {
    assert.equal(maskPhone("5511987654321"), "(11) *******21");
    assert.equal(maskPhone("5531991234567"), "(31) *******67");
  });

  it("trata numero sem codigo de pais", () => {
    assert.equal(maskPhone("11987654321"), "(11) *******21");
  });

  it("nunca revela o miolo do numero", () => {
    const original = "5511987654321";
    const mascarado = maskPhone(original)!;
    assert.ok(!mascarado.includes("98765"), "o miolo vazou");
    assert.ok(!mascarado.includes("9876"), "o miolo vazou");
  });

  it("mascara e-mail preservando o dominio", () => {
    const m = maskEmail("marcelo@empresa.com.br")!;
    assert.ok(m.endsWith("@empresa.com.br"));
    assert.ok(!m.includes("marcelo"));
  });

  it("mascara documentos", () => {
    const m = maskDocument("123.456.789-00")!;
    assert.ok(m.endsWith("00"));
    assert.ok(!m.includes("123"));
  });

  it("devolve undefined para entradas vazias", () => {
    assert.equal(maskPhone(undefined), undefined);
    assert.equal(maskEmail(null), undefined);
  });
});

describe("maskDeep", () => {
  it("mascara campos sensiveis em profundidade", () => {
    const entrada = {
      contact: {
        name: "Marcelo",
        phone: "5511987654321",
        email: "marcelo@empresa.com.br",
        cpf: "12345678900",
      },
      auth: { token: "pn_abcdef123456", authorization: "Bearer pn_xyz" },
      nested: [{ telefone: "5531991234567" }],
    };

    const saida = JSON.stringify(maskDeep(entrada));

    assert.ok(!saida.includes("5511987654321"), "telefone vazou");
    assert.ok(!saida.includes("marcelo@empresa.com.br"), "e-mail vazou");
    assert.ok(!saida.includes("12345678900"), "cpf vazou");
    assert.ok(!saida.includes("pn_abcdef123456"), "token vazou");
    assert.ok(!saida.includes("5531991234567"), "telefone aninhado vazou");

    // Campos nao sensiveis continuam legiveis.
    assert.ok(saida.includes("Marcelo"), "o nome nao precisa ser mascarado");
  });

  it("nao entra em recursao infinita", () => {
    const profundo: Record<string, unknown> = {};
    let cursor = profundo;
    for (let i = 0; i < 30; i += 1) {
      const proximo: Record<string, unknown> = {};
      cursor.next = proximo;
      cursor = proximo;
    }
    assert.doesNotThrow(() => maskDeep(profundo));
  });
});

describe("scrubSecrets", () => {
  it("remove tokens de mensagens de erro", () => {
    const limpo = scrubSecrets(
      "Falha ao chamar API com Authorization: Bearer pn_supersecreto123 no endpoint X",
    );
    assert.ok(!limpo.includes("pn_supersecreto123"));
  });

  it("remove tokens soltos no texto", () => {
    assert.ok(!scrubSecrets("token pn_abc123def456 invalido").includes("pn_abc123def456"));
  });
});
