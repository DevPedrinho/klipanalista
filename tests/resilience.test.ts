import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadOverview } from "@/server/services/intelligence.service";
import { panelsAdapter, cardsAdapter } from "@/server/integration/adapters";
import { ApiError } from "@/server/integration/http/client";
import { resolvePeriod } from "@/server/security/tenant-context";
import type { TenantContext } from "@/domain/types";
import {
  getEnv,
  getIntegrationReadiness,
  resetEnvCache,
} from "@/server/config/env";

/**
 * Resiliência da Central.
 *
 * A Central lê seis fontes independentes. Na primeira conexão com a API real é
 * provável que alguma falhe — um prefixo errado, um token sem permissão. Nesse
 * momento o pior resultado possível é uma tela de erro que não diz nada.
 *
 * Estes testes garantem que a análise continua com o que deu para obter e que
 * a falha é reportada de forma acionável.
 */

const contexto: TenantContext = {
  accountId: "acc_klipflowi_demo",
  userId: "user_elaine",
  role: "ADMIN",
  visibleAgentIds: "ALL",
};

const filtros = { period: resolvePeriod({ preset: "90d" }) };

/** Troca a implementação de um adapter e devolve como restaurá-la. */
function quebrar<T extends object, K extends keyof T>(
  alvo: T,
  metodo: K,
  erro: Error,
): () => void {
  const original = alvo[metodo];
  (alvo[metodo] as unknown) = async () => {
    throw erro;
  };
  return () => {
    alvo[metodo] = original;
  };
}

describe("Central resiste a falhas parciais", () => {
  it("segue analisando conversas quando os paineis falham", async () => {
    const restaurar = quebrar(
      panelsAdapter,
      "list",
      new ApiError({
        kind: "NAO_ENCONTRADO",
        endpointKey: "PANELS_LIST",
        statusCode: 404,
        message: "GET PANELS_LIST respondeu 404.",
      }),
    );

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });

      assert.ok(
        overview.opportunities.length > 0,
        "as oportunidades das conversas devem continuar aparecendo",
      );

      const falha = overview.sourceFailures.find((f) => f.source === "Painéis do CRM");
      assert.ok(falha, "a falha precisa ser reportada");
      assert.equal(falha.kind, "NAO_ENCONTRADO");
      assert.equal(falha.endpoint, "PANELS_LIST", "o endpoint culpado precisa ser nomeado");
    } finally {
      restaurar();
    }
  });

  it("nao inventa funil quando os paineis falham", async () => {
    const restaurar = quebrar(
      panelsAdapter,
      "list",
      new ApiError({ kind: "ERRO_REDE", endpointKey: "PANELS_LIST", message: "sem rede" }),
    );

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });
      assert.deepEqual(overview.funnels, [], "funil vazio e melhor que funil fabricado");
    } finally {
      restaurar();
    }
  });

  it("reporta os cards como fonte propria quando so eles falham", async () => {
    const restaurarCards = quebrar(
      cardsAdapter,
      "listForPanels",
      new ApiError({ kind: "SEM_PERMISSAO", endpointKey: "CARDS_LIST", message: "403" }),
    );

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });
      const falha = overview.sourceFailures.find((f) => f.source === "Cards do CRM");

      assert.ok(falha, "a falha dos cards precisa aparecer com nome proprio");
      assert.equal(falha.endpoint, "CARDS_LIST");
      assert.equal(overview.sourceFailures.length, 1, "os paineis carregaram; so os cards falharam");
    } finally {
      restaurarCards();
    }
  });

  /**
   * Os cards dependem dos paineis: a API exige `panelId` na listagem, entao
   * sem painel nao ha o que pedir. Reportar "Cards do CRM" tambem, nesse
   * caso, transformaria uma causa em duas e mandaria quem le o aviso procurar
   * um problema que nao existe.
   */
  it("nao duplica a falha dos paineis como se os cards tivessem falhado", async () => {
    const restaurarPaineis = quebrar(
      panelsAdapter,
      "list",
      new ApiError({ kind: "NAO_ENCONTRADO", endpointKey: "PANELS_LIST", message: "404" }),
    );

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });
      const fontes = overview.sourceFailures.map((f) => f.source);

      assert.deepEqual(fontes, ["Painéis do CRM"], `uma causa, um aviso: ${fontes.join(", ")}`);
      assert.deepEqual(overview.funnels, []);
    } finally {
      restaurarPaineis();
    }
  });

  /**
   * Um painel inacessivel nao pode custar os cards de todos os outros — mas
   * TODOS inacessiveis nao e "a conta nao tem cards", e sim "nao conseguimos
   * ler o CRM". Confundir os dois faria a Central sugerir criar cards que ja
   * existem.
   */
  it("distingue falha parcial de falha total na leitura dos cards", async () => {
    const original = cardsAdapter.list;
    const erro = new ApiError({
      kind: "SEM_PERMISSAO",
      endpointKey: "CARDS_LIST",
      message: "403",
    });

    // Parcial: o primeiro painel falha, os demais respondem.
    let chamada = 0;
    (cardsAdapter.list as unknown) = async (p: { accountId: string; panelId: string }) => {
      chamada += 1;
      if (chamada === 1) throw erro;
      return original.call(cardsAdapter, p);
    };

    try {
      const parcial = await cardsAdapter.listForPanels({
        accountId: contexto.accountId,
        panelIds: ["painel_a", "painel_b"],
      });
      assert.equal(
        parcial.pendingValidation.some((m) => m.includes("painel_a")),
        true,
        "o painel que falhou precisa ser nomeado",
      );
    } finally {
      cardsAdapter.list = original;
    }

    // Total: nenhum painel responde.
    const restaurar = quebrar(cardsAdapter, "list", erro);
    try {
      await assert.rejects(
        () =>
          cardsAdapter.listForPanels({
            accountId: contexto.accountId,
            panelIds: ["painel_a", "painel_b"],
          }),
        /403/,
      );
    } finally {
      restaurar();
    }
  });

  it("nao reporta falha nenhuma quando tudo carrega", async () => {
    const overview = await loadOverview({ context: contexto, filters: filtros });
    assert.deepEqual(overview.sourceFailures, []);
    assert.ok(overview.opportunities.length > 0);
  });

  it("derruba a analise se os usuarios falharem", async () => {
    // Sem usuarios nao ha perfil nem escopo: responder seria inseguro.
    const { agentsAdapter } = await import("@/server/integration/adapters");
    const restaurar = quebrar(
      agentsAdapter,
      "list",
      new ApiError({ kind: "NAO_AUTENTICADO", endpointKey: "AGENTS_LIST", message: "401" }),
    );

    try {
      await assert.rejects(
        () => loadOverview({ context: contexto, filters: filtros }),
        /401|AGENTS_LIST/,
      );
    } finally {
      restaurar();
    }
  });
});

/* ==========================================================================
   Configuração mínima
   ==========================================================================
   Só a credencial é segredo. As URLs base são endereço público confirmado na
   documentação, então têm padrão — quem instala digita um campo, não quatro.
   ========================================================================== */
describe("configuracao de ambiente", () => {
  const CHAVES = [
    "FLW_API_TOKEN",
    "FLW_DATA_MODE",
    "FLW_CORE_API_URL",
    "FLW_CHAT_API_URL",
    "FLW_CRM_API_URL",
  ];

  function comAmbiente<T>(vars: Record<string, string>, fn: () => T): T {
    const anterior = new Map(CHAVES.map((k) => [k, process.env[k]]));
    for (const k of CHAVES) delete process.env[k];
    Object.assign(process.env, vars);
    resetEnvCache();

    try {
      return fn();
    } finally {
      for (const k of CHAVES) delete process.env[k];
      for (const [k, v] of anterior) if (v !== undefined) process.env[k] = v;
      resetEnvCache();
    }
  }

  it("so o token ja basta para valer como integracao pronta", () => {
    comAmbiente({ FLW_API_TOKEN: "pn_exemplo" }, () => {
      const r = getIntegrationReadiness();
      assert.equal(r.ready, true);
      assert.deepEqual(r.missing, [], "nada mais deve ser exigido");
      assert.equal(r.dataMode, "live");
    });
  });

  it("sem token, opera com dados simulados e diz o que falta", () => {
    comAmbiente({}, () => {
      const r = getIntegrationReadiness();
      assert.equal(r.ready, false);
      assert.deepEqual(r.missing, ["FLW_API_TOKEN"]);
      assert.equal(r.dataMode, "mock");
    });
  });

  it("aplica as URLs oficiais como padrao", () => {
    comAmbiente({ FLW_API_TOKEN: "pn_x" }, () => {
      const env = getEnv();
      assert.equal(env.coreApiUrl, "https://api.wts.chat/core");
      assert.equal(env.chatApiUrl, "https://api.wts.chat/chat");
      assert.equal(env.crmApiUrl, "https://api.wts.chat/crm");
    });
  });

  it("deixa a instancia sobrescrever qualquer URL", () => {
    comAmbiente({ FLW_API_TOKEN: "pn_x", FLW_CRM_API_URL: "https://interno/crm/" }, () => {
      const env = getEnv();
      assert.equal(env.crmApiUrl, "https://interno/crm", "barra final removida");
      assert.equal(env.coreApiUrl, "https://api.wts.chat/core", "as outras seguem no padrao");
    });
  });

  it("permite desligar a integracao sem remover a credencial", () => {
    comAmbiente({ FLW_API_TOKEN: "pn_x", FLW_DATA_MODE: "mock" }, () => {
      assert.equal(getEnv().dataMode, "mock");
    });
  });
});
