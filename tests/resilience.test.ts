import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadOverview } from "@/server/services/intelligence.service";
import { panelsAdapter, cardsAdapter } from "@/server/integration/adapters";
import { ApiError } from "@/server/integration/http/client";
import { resolvePeriod } from "@/server/security/tenant-context";
import type { TenantContext } from "@/domain/types";

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

  it("reporta cada fonte que falhou, separadamente", async () => {
    const restaurarPaineis = quebrar(
      panelsAdapter,
      "list",
      new ApiError({ kind: "NAO_ENCONTRADO", endpointKey: "PANELS_LIST", message: "404" }),
    );
    const restaurarCards = quebrar(
      cardsAdapter,
      "list",
      new ApiError({ kind: "SEM_PERMISSAO", endpointKey: "CARDS_LIST", message: "403" }),
    );

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });
      const fontes = overview.sourceFailures.map((f) => f.source);

      assert.ok(fontes.includes("Painéis do CRM"));
      assert.ok(fontes.includes("Cards do CRM"));
      assert.equal(overview.sourceFailures.length, 2);
    } finally {
      restaurarPaineis();
      restaurarCards();
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
