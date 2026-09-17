import { getEnv, getIntegrationReadiness } from "@/server/config/env";
import { ENDPOINTS, type EndpointContract } from "@/server/integration/endpoints";
import { ApiError, apiRequest } from "@/server/integration/http/client";
import { ok } from "@/server/http/respond";

/**
 * GET /api/health/probe
 *
 * Teste de conectividade real contra a API da KlipFlowi.
 *
 * `/api/health` responde se a CONFIGURACAO esta completa. Isso nao prova
 * nada: um token valido com URL errada tem exatamente a mesma aparencia de
 * um ambiente funcionando. Esta rota chama de fato cada endpoint de leitura
 * e informa, um por um, o que respondeu e o que nao respondeu.
 *
 * O QUE ESTA ROTA NAO DEVOLVE: conteudo de conversa, nome de contato,
 * telefone, e-mail, valor de negociacao. Apenas o codigo HTTP, a quantidade
 * de registros e os NOMES DOS CAMPOS que o payload traz — que e justamente
 * o necessario para conferir se os mapeadores leem as propriedades certas,
 * sem expor o dado de ninguem.
 *
 * Somente GET. Nenhuma escrita e disparada aqui.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Sem repeticao e com prazo curto: aqui queremos o diagnostico, nao insistencia. */
const TENTATIVA = { maxRetries: 0, timeoutMs: 8_000 } as const;

interface ProbeResult {
  key: string;
  method: string;
  path: string;
  group: string;
  ok: boolean;
  httpStatus?: number;
  kind?: string;
  message?: string;
  /** Quantidade de registros lidos na primeira pagina. */
  count?: number;
  /** Nomes dos campos do primeiro registro. Nunca os valores. */
  campos?: string[];
  ms: number;
}

/** Le a lista de itens de um payload, qualquer que seja o formato de envelope. */
function extrairItens(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return null;
  for (const key of ["items", "data", "results", "content", "records"]) {
    const candidato = record[key];
    if (Array.isArray(candidato)) return candidato;
  }
  return null;
}

/** Nomes das propriedades de um objeto, em ordem alfabetica. Sem valores. */
function nomesDosCampos(valor: unknown): string[] | undefined {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return undefined;
  return Object.keys(valor as Record<string, unknown>).sort();
}

interface Sondagem {
  resultado: ProbeResult;
  /** Itens da listagem, quando o payload for uma listagem. */
  itens: unknown[] | null;
  /** Payload cru, para endpoints de detalhe, que nao devolvem lista. */
  payload: unknown;
}

async function sondar(
  contract: EndpointContract,
  options: {
    pathParams?: Record<string, string>;
    query?: Record<string, string | number>;
  } = {},
): Promise<Sondagem> {
  const inicio = Date.now();

  try {
    const resposta = await apiRequest<unknown>(contract, { ...TENTATIVA, ...options });
    const itens = extrairItens(resposta.data);
    const primeiro = itens ? itens[0] : resposta.data;

    return {
      itens,
      payload: resposta.data,
      resultado: {
        key: contract.key,
        method: contract.method,
        path: contract.path,
        group: contract.group,
        ok: true,
        httpStatus: resposta.status,
        count: itens?.length,
        campos: nomesDosCampos(primeiro),
        ms: Date.now() - inicio,
      },
    };
  } catch (error) {
    const apiError = error instanceof ApiError ? error : null;

    return {
      itens: null,
      payload: null,
      resultado: {
        key: contract.key,
        method: contract.method,
        path: contract.path,
        group: contract.group,
        ok: false,
        httpStatus: apiError?.statusCode,
        kind: apiError?.kind ?? "ERRO_INTERNO",
        // A mensagem do ApiError ja passa por scrubSecrets no construtor.
        message: (error as Error).message.slice(0, 300),
        ms: Date.now() - inicio,
      },
    };
  }
}

/** Le um id de um registro sem devolver nenhum outro campo. */
function idDoPrimeiro(itens: unknown[] | null): string | undefined {
  const primeiro = itens?.[0] as Record<string, unknown> | undefined;
  const id = primeiro?.["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** "Carla Mendes" -> "Carla M." — suficiente para a pessoa se reconhecer. */
function abreviarNome(valor: unknown): string | undefined {
  if (typeof valor !== "string" || valor.trim().length === 0) return undefined;
  const partes = valor.trim().split(/\s+/);
  const primeiro = partes[0] ?? "";
  const ultimo = partes.length > 1 ? partes[partes.length - 1] : undefined;
  return ultimo ? `${primeiro} ${ultimo.charAt(0)}.` : primeiro;
}

export async function GET() {
  const readiness = getIntegrationReadiness();

  if (!readiness.ready) {
    return ok(
      {
        executado: false,
        motivo:
          readiness.dataMode === "mock"
            ? "O modulo esta em modo simulado. Configure FLW_API_TOKEN para testar a integracao real."
            : `Falta configurar: ${readiness.missing.join(", ")}.`,
        missingEnvVars: readiness.missing,
      },
      { dataMode: readiness.dataMode },
    );
  }

  const env = getEnv();

  // Primeira rodada: listagens que nao dependem de nenhum id.
  const primeiraRodada = await Promise.all([
    sondar(ENDPOINTS.AGENTS.LIST, { query: { page: 1, pageSize: 5 } }),
    sondar(ENDPOINTS.DEPARTMENTS.LIST, { query: { page: 1, pageSize: 5 } }),
    sondar(ENDPOINTS.TAGS.LIST, { query: { page: 1, pageSize: 5 } }),
    sondar(ENDPOINTS.CHANNELS.LIST, { query: { page: 1, pageSize: 5 } }),
    sondar(ENDPOINTS.SESSIONS.LIST, { query: { page: 1, pageSize: 5 } }),
    sondar(ENDPOINTS.CONTACTS.LIST, { query: { page: 1, pageSize: 5 } }),
    sondar(ENDPOINTS.PANELS.LIST, { query: { page: 1, pageSize: 20 } }),
    sondar(ENDPOINTS.CONTACTS.CUSTOM_FIELDS, {}),
    sondar(ENDPOINTS.WEBHOOKS.LIST_EVENTS, {}),
    sondar(ENDPOINTS.WEBHOOKS.LIST_SUBSCRIPTIONS, {}),
  ]);

  const agentes = primeiraRodada[0];
  const sessoes = primeiraRodada[4];
  const paineis = primeiraRodada[6];

  // Segunda rodada: caminhos aninhados, usando ids descobertos acima.
  // So dispara o que tem id real — chamar com id inventado produziria um 404
  // que nao significa nada.
  const sessionId = idDoPrimeiro(sessoes?.itens ?? null);
  const painelBruto = (paineis?.itens ?? []) as Record<string, unknown>[];

  /**
   * Configuracao do CRM da conta.
   *
   * Isto e metadado de configuracao — titulo do painel, tipo e nome das
   * etapas — e nao dado de cliente. Sao exatamente os valores necessarios
   * para saber qual painel e de Vendas e para conferir se a recomendacao de
   * etapa reconhece a nomenclatura da casa.
   */
  const resumoDosPaineis = painelBruto.map((painel) => ({
    id: typeof painel["id"] === "string" ? painel["id"] : undefined,
    titulo: typeof painel["title"] === "string" ? painel["title"] : undefined,
    // CONFIRMADO: os literais sao SALES e MANAGEMENT.
    tipoBruto: typeof painel["type"] === "string" ? painel["type"] : null,
    arquivado: painel["archived"] ?? null,
  }));

  /**
   * So os paineis de VENDAS sao aprofundados.
   *
   * A conta tem 20 paineis e 18 sao quadros pessoais de tarefas. Sondar
   * todos gastaria 40 chamadas para produzir 36 erros previsiveis — a
   * propria API recusa motivos de perda fora de painel de Vendas.
   */
  const vendasIds = resumoDosPaineis
    .filter((p) => p.tipoBruto === "SALES")
    .map((p) => p.id)
    .filter((id): id is string => Boolean(id));

  const segundaRodada = await Promise.all([
    ...(sessionId
      ? [
          sondar(ENDPOINTS.SESSIONS.GET_BY_ID, { pathParams: { id: sessionId } }),
          sondar(ENDPOINTS.MESSAGES.LIST_BY_SESSION, {
            pathParams: { id: sessionId },
            query: { page: 1, pageSize: 5 },
          }),
        ]
      : []),
    // A listagem de cards EXIGE panelId — sem ele responde 500
    // "The PanelId field is required.".
    ...vendasIds.map((id) =>
      sondar(ENDPOINTS.CARDS.LIST, { query: { panelId: id, page: 1, pageSize: 5 } }),
    ),
    ...vendasIds.map((id) =>
      sondar(ENDPOINTS.PANELS.LOST_REASONS, {
        pathParams: { id },
        query: { page: 1, pageSize: 5 },
      }),
    ),
    // O detalhe do painel: e dele que saem as etapas do funil. A listagem
    // devolve `steps` vazio, entao e aqui que da para conferir se a
    // recomendacao de etapa reconhece a nomenclatura da casa.
    ...vendasIds.map((id) => sondar(ENDPOINTS.PANELS.GET_BY_ID, { pathParams: { id } })),
  ]);

  /** Etapas do funil, lidas do DETALHE de cada painel de vendas. */
  const funis = segundaRodada
    .filter((r) => r.resultado.key === "PANELS_GET_BY_ID" && r.resultado.ok)
    .map((r) => {
      // O detalhe nao e uma listagem: o payload e o proprio painel.
      const painel = (r.payload ?? {}) as Record<string, unknown>;
      const steps = Array.isArray(painel["steps"]) ? (painel["steps"] as unknown[]) : [];

      return {
        titulo: painel["title"] ?? null,
        camposDaEtapa: nomesDosCampos(steps[0]),
        etapas: steps.map((step) => {
          const s = step as Record<string, unknown>;
          return {
            titulo: s["title"] ?? s["name"] ?? null,
            ordem: s["order"] ?? s["position"] ?? null,
            faseBruta: s["phase"] ?? s["stepPhase"] ?? s["type"] ?? null,
          };
        }),
      };
    });

  const crm = { paineis: resumoDosPaineis, funis };

  const primeiroCard = segundaRodada.find(
    (r) => r.resultado.key === "CARDS_LIST" && r.resultado.ok,
  );
  const cardId = idDoPrimeiro(primeiroCard?.itens ?? null);

  const terceiraRodada = cardId
    ? await Promise.all([sondar(ENDPOINTS.CARDS.GET_BY_ID, { pathParams: { id: cardId } })])
    : [];

  const resultados = [...primeiraRodada, ...segundaRodada, ...terceiraRodada].map(
    (r) => r.resultado,
  );
  const falhas = resultados.filter((r) => !r.ok);

  /**
   * Identificadores para abrir a Central.
   *
   * A pagina exige accountId e userId. Em modo real o accountId e apenas um
   * rotulo — quem define a conta e o token —, mas o userId precisa existir de
   * verdade: e dele que sai o perfil e o escopo de visibilidade.
   *
   * Nomes vem abreviados de proposito.
   */
  const usuarios = (agentes?.itens ?? []).slice(0, 25).map((item) => {
    const registro = item as Record<string, unknown>;
    return {
      id: typeof registro["id"] === "string" ? registro["id"] : undefined,
      nome: abreviarNome(registro["name"]),
      // Campos crus de perfil: mostram como a API representa o papel, que e
      // exatamente a pendencia registrada em agents.adapter.ts.
      perfilBruto: registro["role"] ?? registro["profile"] ?? registro["type"] ?? null,
      isAdmin: registro["isAdmin"] ?? null,
      departmentId: registro["departmentId"] ?? null,
    };
  });

  const primeiroUsuario = usuarios[0];

  return ok(
    {
      executado: true,
      resumo: {
        total: resultados.length,
        responderam: resultados.length - falhas.length,
        falharam: falhas.length,
      },
      baseUrls: {
        core: env.coreApiUrl,
        chat: env.chatApiUrl,
        crm: env.crmApiUrl,
      },
      comoAbrirACentral: primeiroUsuario?.id
        ? `/inteligencia-comercial?accountId=klipflowi&userId=${primeiroUsuario.id}&preset=30d`
        : "Nenhum usuario retornado: sem userId valido a Central nao abre.",
      usuarios,
      crm,
      resultados,
    },
    { dataMode: readiness.dataMode },
  );
}
