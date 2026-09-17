import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadOverview } from "@/server/services/intelligence.service";
import { panelsAdapter, cardsAdapter } from "@/server/integration/adapters";
import {
  ApiError,
  apiRequestAllPagesWithOutcome,
} from "@/server/integration/http/client";
import { resolvePeriod } from "@/server/security/tenant-context";
import type { TenantContext } from "@/domain/types";
import type { EndpointContract } from "@/server/integration/endpoints";
import { MOCK_CONVERSATIONS } from "@/mocks/dataset";
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

/**
 * Limites de trabalho por requisicao.
 *
 * A primeira chamada real de /api/intelligence/overview nao devolveu nada:
 * estourou o tempo limite. A causa era estrutural — a API entrega as
 * mensagens por conversa, e o adapter lia ate 8 paginas de cada uma, o que
 * numa conta movimentada vira centenas de chamadas numa unica requisicao.
 *
 * O modulo passa a trabalhar com teto e com prazo. O que estes testes
 * protegem nao e a velocidade, e a HONESTIDADE: quando nao da para analisar
 * tudo, a resposta precisa sair mesmo assim e dizer o que ficou de fora.
 */
describe("Central respeita teto e prazo", () => {
  /** Troca uma variavel de ambiente e devolve como restaura-la. */
  function comAmbiente(nome: string, valor: string): () => void {
    const anterior = process.env[nome];
    process.env[nome] = valor;
    return () => {
      if (anterior === undefined) delete process.env[nome];
      else process.env[nome] = anterior;
    };
  }

  it("analisa no maximo o teto de conversas e avisa o que ficou de fora", async () => {
    const restaurar = comAmbiente("FLW_MAX_CONVERSAS", "2");

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });

      assert.equal(overview.coverage.teto, 2);
      assert.ok(
        overview.coverage.conversasNoPeriodo > 2,
        "o cenario precisa ter mais conversas que o teto para o teste valer",
      );
      assert.equal(overview.coverage.truncado, true);
      assert.ok(
        overview.pendingValidation.some((m) => m.includes("conversas mais recentes")),
        "quem le a tela precisa saber que a analise foi parcial",
      );
    } finally {
      restaurar();
    }
  });

  it("prioriza as conversas mais recentes quando precisa escolher", async () => {
    const restaurar = comAmbiente("FLW_MAX_CONVERSAS", "1");

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });
      const analisada = overview.opportunities[0];

      // A unica conversa analisada precisa ser a mais recente do periodo.
      const maisRecente = [...MOCK_CONVERSATIONS]
        .filter((c) => c.accountId === contexto.accountId)
        .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))[0];

      assert.ok(maisRecente);
      if (analisada) {
        assert.equal(
          analisada.sessionId,
          maisRecente.id,
          "uma conversa de hoje diz mais sobre o que fazer agora do que uma antiga",
        );
      }
    } finally {
      restaurar();
    }
  });

  it("devolve resposta mesmo com o prazo ja esgotado, dizendo que parou por tempo", async () => {
    const restaurar = comAmbiente("FLW_TEMPO_MAXIMO_MS", "0");

    try {
      const overview = await loadOverview({ context: contexto, filters: filtros });

      assert.equal(overview.coverage.interrompidaPorTempo, true);
      assert.equal(
        overview.coverage.conversasAnalisadas,
        0,
        "sem tempo, nenhuma conversa tem as mensagens lidas",
      );
      assert.ok(
        overview.pendingValidation.some((m) => m.includes("limite de tempo")),
        "parar por tempo precisa aparecer na tela, nao virar silencio",
      );
    } finally {
      restaurar();
    }
  });

  it("registra o tempo de cada fase, para diagnostico", async () => {
    const overview = await loadOverview({ context: contexto, filters: filtros });

    for (const fase of ["snapshots", "cards", "mensagens"]) {
      assert.ok(
        typeof overview.coverage.tempos[fase] === "number",
        `a fase "${fase}" precisa ser medida`,
      );
    }
  });
});

/**
 * Paginação que não avança.
 *
 * A sonda contra a conta real mostrou que as páginas 1, 2 e 10 de
 * GET /chat/v2/session devolvem exatamente os mesmos registros: o parâmetro
 * de página que o cliente envia está sendo ignorado pela API.
 *
 * Sem defesa, o módulo somava dez cópias da mesma página e reportava 500
 * conversas onde havia 50 — todos os indicadores da Central inflados dez
 * vezes, sem nenhum sinal de erro. Este é o tipo de defeito que só aparece
 * contra dados reais e que ninguém percebe olhando a tela.
 */
describe("paginacao que nao avanca", () => {
  /*
   * O cliente HTTP exige credencial antes de montar qualquer requisicao.
   * Aqui o `fetch` e substituido, entao o valor nunca sai da memoria — mas
   * ele precisa existir para o cliente chegar a enviar a chamada.
   */
  const anterior = process.env["FLW_API_TOKEN"];

  before(() => {
    process.env["FLW_API_TOKEN"] = "token-de-teste";
    resetEnvCache();
  });

  after(() => {
    if (anterior === undefined) delete process.env["FLW_API_TOKEN"];
    else process.env["FLW_API_TOKEN"] = anterior;
    resetEnvCache();
  });

  const contrato: EndpointContract = {
    key: "TESTE_LIST",
    method: "GET",
    path: "/v1/teste",
    group: "core",
    trust: "CONFIRMED",
    pending: [],
    summary: "listagem de teste",
  };

  /** Substitui o fetch global e devolve como restaurá-lo. */
  function comFetch(responder: (url: string) => unknown): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (entrada: string | URL | Request) => {
      const url = typeof entrada === "string" ? entrada : entrada.toString();
      return new Response(JSON.stringify(responder(url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("para de paginar quando a pagina repete, em vez de somar copias", async () => {
    // A API ignora o parametro de pagina: toda chamada devolve os mesmos 3.
    const mesmosSempre = { items: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    let chamadas = 0;

    const restaurar = comFetch(() => {
      chamadas += 1;
      return mesmosSempre;
    });

    try {
      const { items, outcome } = await apiRequestAllPagesWithOutcome<{ id: string }>(
        contrato,
        {},
        { pageSize: 3 },
        10,
      );

      assert.deepEqual(
        items.map((i) => i.id),
        ["a", "b", "c"],
        "tres registros unicos continuam sendo tres, nao trinta",
      );
      assert.equal(outcome.repetiu, true, "a repeticao precisa ser detectada");
      assert.equal(chamadas, 2, "basta uma pagina repetida para parar");
    } finally {
      restaurar();
    }
  });

  it("continua paginando normalmente quando as paginas avancam", async () => {
    const paginas: Record<string, { items: { id: string }[] }> = {
      "1": { items: [{ id: "a" }, { id: "b" }] },
      "2": { items: [{ id: "c" }, { id: "d" }] },
      "3": { items: [{ id: "e" }] },
    };

    const restaurar = comFetch((url) => {
      const numero = new URL(url).searchParams.get("page") ?? "1";
      return paginas[numero] ?? { items: [] };
    });

    try {
      const { items, outcome } = await apiRequestAllPagesWithOutcome<{ id: string }>(
        contrato,
        {},
        { pageSize: 2 },
        10,
      );

      assert.deepEqual(items.map((i) => i.id), ["a", "b", "c", "d", "e"]);
      assert.equal(outcome.repetiu, false);
    } finally {
      restaurar();
    }
  });

  it("nao duplica um registro que aparece em duas paginas", async () => {
    const paginas: Record<string, { items: { id: string }[] }> = {
      "1": { items: [{ id: "a" }, { id: "b" }] },
      // "b" repetido: acontece quando algo e inserido entre uma pagina e outra.
      "2": { items: [{ id: "b" }, { id: "c" }] },
      "3": { items: [] },
    };

    const restaurar = comFetch((url) => {
      const numero = new URL(url).searchParams.get("page") ?? "1";
      return paginas[numero] ?? { items: [] };
    });

    try {
      const { items } = await apiRequestAllPagesWithOutcome<{ id: string }>(
        contrato,
        {},
        { pageSize: 2 },
        10,
      );

      assert.deepEqual(items.map((i) => i.id), ["a", "b", "c"]);
    } finally {
      restaurar();
    }
  });
});
