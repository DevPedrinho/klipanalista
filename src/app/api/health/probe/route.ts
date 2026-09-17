import { type NextRequest } from "next/server";
import { getEnv, getIntegrationReadiness } from "@/server/config/env";
import {
  agentsAdapter,
  contactsAdapter,
  panelsAdapter,
  sessionsAdapter,
  tagsAdapter,
} from "@/server/integration/adapters";
import { ENDPOINTS, type EndpointContract } from "@/server/integration/endpoints";
import { ApiError, apiRequest } from "@/server/integration/http/client";
import { ok } from "@/server/http/respond";
import { mascararContato } from "@/server/ai/opportunity-analyst";

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
  /**
   * Metadados do ENVELOPE da listagem: nomes das chaves e os valores
   * NUMERICOS (total de registros, total de paginas). Contagem nao e dado
   * de cliente, e e o unico jeito de saber o tamanho real da conta sem
   * varrer tudo.
   */
  envelope?: { chaves: string[]; numeros: Record<string, number> };
  ms: number;
}

/** Chaves e contadores do envelope, sem nenhum conteudo de registro. */
function lerEnvelope(
  payload: unknown,
): { chaves: string[]; numeros: Record<string, number> } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  const registro = payload as Record<string, unknown>;
  const numeros: Record<string, number> = {};

  for (const [chave, valor] of Object.entries(registro)) {
    if (typeof valor === "number") numeros[chave] = valor;
  }

  return { chaves: Object.keys(registro).sort(), numeros };
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
        envelope: lerEnvelope(resposta.data),
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

/**
 * Mede quanto tempo cada ADAPTER leva de ponta a ponta.
 *
 * A sonda normal mede uma chamada por endpoint. Os adapters fazem mais do
 * que isso: paginam, buscam detalhe, tentam de novo com backoff. Foi ai que
 * o tempo da Central se perdeu, e medir uma chamada isolada nao mostrava.
 *
 * Cada medicao tem prazo proprio, para que a propria sonda sempre responda.
 */
async function medirAdapters(accountId: string, prazoMs: number) {
  async function medir<T>(
    nome: string,
    executar: () => Promise<{ data: T[] }>,
  ): Promise<{ fonte: string; ms: number; itens?: number; erro?: string }> {
    const inicio = Date.now();

    const estouro = new Promise<"ESTOUROU">((resolve) =>
      setTimeout(() => resolve("ESTOUROU"), prazoMs),
    );

    try {
      const resultado = await Promise.race([executar(), estouro]);

      if (resultado === "ESTOUROU") {
        return { fonte: nome, ms: Date.now() - inicio, erro: `passou de ${prazoMs}ms` };
      }
      return { fonte: nome, ms: Date.now() - inicio, itens: resultado.data.length };
    } catch (error) {
      return {
        fonte: nome,
        ms: Date.now() - inicio,
        erro: (error as Error).message.slice(0, 200),
      };
    }
  }

  // Em sequencia, de proposito: em paralelo os tempos se contaminam pelo
  // limitador de vazao e nao diriam qual fonte e a lenta.
  return [
    await medir("Conversas", () => sessionsAdapter.list({ accountId })),
    await medir("Contatos", () => contactsAdapter.list({ accountId })),
    await medir("Paineis", () => panelsAdapter.list({ accountId })),
    await medir("Usuarios", () => agentsAdapter.list({ accountId })),
    await medir("Etiquetas", () => tagsAdapter.list({ accountId })),
  ];
}

/**
 * Descobre em que ORDEM a listagem de conversas devolve os registros.
 *
 * A pergunta nao e academica. O modulo le no maximo 10 paginas e analisa as
 * mais recentes DENTRE ELAS. Se a API entrega da mais antiga para a mais
 * nova, essas 10 paginas sao as 500 conversas mais ANTIGAS da conta, e o
 * periodo de 7 dias nao encontra nada — foi exatamente o que aconteceu: 500
 * conversas lidas, zero oportunidades.
 *
 * Em vez de supor um parametro de ordenacao que nao esta documentado, isto
 * observa o comportamento real: le paginas distintas e compara as datas.
 */
/**
 * Descobre a ORDEM e os filtros reais da listagem de conversas.
 *
 * Refeita depois de um erro meu: a versao anterior paginava com `page`, que a
 * API ignora. Todas as paginas voltavam identicas e a sonda "provou" que a
 * ordem nao mudava — quando na verdade nao tinha saido do lugar.
 *
 * A pergunta que importa: as 10 paginas que o modulo le sao as conversas
 * MAIS NOVAS ou as MAIS VELHAS da conta? Se forem as mais velhas, o modulo
 * analisa o passado e nunca ve o movimento de hoje, que e exatamente o que
 * ele existe para encontrar.
 */
async function medirOrdemDasConversas() {
  async function pagina(numero: number, extra: Record<string, string | number> = {}) {
    const inicio = Date.now();
    try {
      const resposta = await apiRequest<unknown>(ENDPOINTS.SESSIONS.LIST, {
        ...TENTATIVA,
        // CONFIRMADO: `pageNumber` e o parametro que avanca.
        query: { pageNumber: numero, pageSize: 20, ...extra },
      });

      const itens = extrairItens(resposta.data) ?? [];
      const datas = itens
        .map((item) => (item as Record<string, unknown>)["lastInteractionDate"])
        .filter((d): d is string => typeof d === "string")
        .sort();

      return {
        pagina: numero,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
        itens: itens.length,
        maisAntiga: datas[0] ?? null,
        maisRecente: datas[datas.length - 1] ?? null,
        erro: undefined as string | undefined,
        ms: Date.now() - inicio,
      };
    } catch (error) {
      return {
        pagina: numero,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
        itens: 0,
        maisAntiga: null,
        maisRecente: null,
        erro: (error as Error).message.slice(0, 200),
        ms: Date.now() - inicio,
      };
    }
  }

  // Direcao: paginas espalhadas revelam se a lista vai do novo para o velho
  // ou o contrario — e se ha conversas recentes alem da pagina 10.
  const direcao = [
    await pagina(1),
    await pagina(2),
    await pagina(10),
    await pagina(25),
    await pagina(60),
  ];

  /**
   * Candidatos a ordenacao e a filtro de data.
   *
   * Nenhum entra no modulo por suposicao: so vale o que mudar o resultado de
   * forma verificavel. `updatedAfter` ja foi testado e NAO tem efeito.
   */
  const referencia = direcao[0];
  const mudou = (r: { maisRecente?: string | null; maisAntiga?: string | null }) =>
    Boolean(referencia) &&
    (r.maisRecente !== referencia?.maisRecente || r.maisAntiga !== referencia?.maisAntiga);

  const ordenacao = [];
  for (const [chave, valor] of [
    ["orderBy", "lastInteractionDate"],
    ["sort", "-lastInteractionDate"],
    ["sortBy", "lastInteractionDate"],
    ["order", "desc"],
    ["descending", "true"],
    ["orderByDescending", "true"],
  ] as [string, string][]) {
    const r = await pagina(1, { [chave]: valor });
    ordenacao.push({ parametro: `${chave}=${valor}`, mudou: mudou(r), ...r });
  }

  const recente = "2026-09-01T00:00:00Z";
  const filtros = [];
  for (const [chave, valor] of [
    ["startDate", recente],
    ["from", recente],
    ["lastInteractionDate.gte", recente],
    ["lastInteractionDateStart", recente],
    ["createdAtStart", recente],
    ["initialDate", recente],
  ] as [string, string][]) {
    const r = await pagina(1, { [chave]: valor });
    filtros.push({ parametro: `${chave}=${valor}`, mudou: mudou(r), ...r });
  }

  return { direcao, ordenacao, filtros };
}

/**
 * Procura de onde vem o NOME das etapas do funil.
 *
 * Medido contra a conta real: `/v2/panel` e `/v1/panel/{id}` devolvem
 * `steps: null` e `stepTitles: null`, e o campo `stepTitle` dos cards tambem
 * chega nulo. O resultado e um funil inteiro rotulado "Etapa sem nome" —
 * legivel para a maquina, inutil para quem precisa reconhecer o proprio
 * processo comercial. A Central da KlipFlowi mostra os nomes, entao eles
 * existem em algum endpoint que o modulo ainda nao conhece.
 *
 * Este modo tenta os candidatos e diz qual responde. Nao supoe nenhum: cada
 * tentativa aparece com o status HTTP e os campos do primeiro item, e a
 * conclusao fica visivel em vez de escondida numa suposicao de codigo.
 */
async function procurarEtapas(panelId: string) {
  const candidatos: { path: string; group: "core" | "chat" | "crm"; query?: Record<string, string> }[] = [
    { path: "/v1/panel/{id}/step", group: "crm" },
    { path: "/v2/panel/{id}/step", group: "crm" },
    { path: "/v1/panel/{id}/steps", group: "crm" },
    { path: "/v1/panel/step", group: "crm", query: { panelId } },
    { path: "/v2/panel/step", group: "crm", query: { panelId } },
    { path: "/v1/panel/{id}/stage", group: "crm" },
  ];

  const tentativas = await Promise.all(
    candidatos.map(async (candidato) => {
      const contrato: EndpointContract = {
        key: "SONDA_ETAPAS",
        method: "GET",
        path: candidato.path,
        group: candidato.group,
        trust: "PENDING_VALIDATION",
        pending: ["Caminho candidato: existe apenas nesta sonda."],
        summary: "Tentativa de descobrir as etapas do painel.",
      };

      const sondagem = await sondar(contrato, {
        pathParams: { id: panelId },
        ...(candidato.query ? { query: candidato.query } : {}),
      });

      const primeiro = (sondagem.itens ?? [])[0] as Record<string, unknown> | undefined;

      return {
        caminho: candidato.path,
        ok: sondagem.resultado.ok,
        httpStatus: sondagem.resultado.httpStatus,
        quantidade: sondagem.resultado.count ?? null,
        campos: sondagem.resultado.campos ?? null,
        // O que importa e se ha um nome legivel: e essa a pergunta.
        exemploDeNome: primeiro
          ? (primeiro["title"] ?? primeiro["name"] ?? primeiro["description"] ?? null)
          : null,
      };
    }),
  );

  const venceu = tentativas.find((t) => t.ok && (t.quantidade ?? 0) > 0 && t.exemploDeNome);

  return {
    painel: panelId,
    tentativas,
    conclusao: venceu
      ? "As etapas vem de " + venceu.caminho + "."
      : "Nenhum candidato devolveu etapas nomeadas. O nome pode nao estar exposto na API.",
  };
}

/**
 * Abre UMA conversa pelo id e mostra o que aconteceu nela.
 *
 * Diferente do resto desta rota, este modo devolve CONTEUDO — e por isso
 * existe sob demanda, com o id informado explicitamente por quem pergunta,
 * e nunca varre a conta. Telefone, e-mail, CPF e CNPJ saem mascarados como
 * em qualquer outro caminho do modulo.
 *
 * Tambem responde uma pergunta de diagnostico: esta conversa aparece na
 * varredura que a Central faz? Se nao aparecer, e a prova de que a leitura
 * esta pegando a parte errada da conta.
 */
async function abrirConversa(sessionId: string) {
  const sessao = await sondar(ENDPOINTS.SESSIONS.GET_BY_ID, {
    pathParams: { id: sessionId },
  });

  const mensagens = await sondar(ENDPOINTS.MESSAGES.LIST_BY_SESSION, {
    pathParams: { id: sessionId },
    query: { pageNumber: 1, pageSize: 100 },
  });

  const bruto = (sessao.payload ?? {}) as Record<string, unknown>;

  const conversa = {
    id: bruto["id"] ?? null,
    numero: bruto["number"] ?? null,
    status: bruto["status"] ?? null,
    statusDescricao: bruto["statusDescription"] ?? null,
    canal: bruto["channelType"] ?? null,
    inicio: bruto["startAt"] ?? null,
    fim: bruto["endAt"] ?? null,
    ultimaInteracao: bruto["lastInteractionDate"] ?? null,
    ultimaDoCliente: bruto["lastMessageIn"] ?? null,
    ultimaEnviada: bruto["lastMessageOut"] ?? null,
    primeiraResposta: bruto["firstResponseAt"] ?? null,
    segundosDeEspera: bruto["timeWait"] ?? null,
    segundosDeAtendimento: bruto["timeService"] ?? null,
    naoLidas: bruto["unreadCount"] ?? null,
    origem: bruto["origin"] ?? null,
    atendenteId: bruto["userId"] ?? null,
    contatoId: bruto["contactId"] ?? null,
  };

  /*
   * Mensagem de AUDIO crua, para localizar a transcricao.
   *
   * A KlipFlowi mostra "Transcricao" na tela do atendimento, entao o texto
   * existe em algum lugar do payload. O modulo hoje le so `text`, que vem
   * vazio em audio — e como 12 das 20 mensagens desta conversa sao audio, o
   * miolo da negociacao fica invisivel para a analise.
   *
   * Este bloco devolve o objeto inteiro de um audio para descobrir onde o
   * texto esta (`details` e o candidato mais provavel).
   */
  const audioCru = (mensagens.itens ?? []).find((item) => {
    const m = item as Record<string, unknown>;
    return m["type"] === "AUDIO";
  });

  const falas = (mensagens.itens ?? []).map((item) => {
    const m = item as Record<string, unknown>;
    const detalhes = (m["details"] ?? {}) as Record<string, unknown>;
    const transcricao = (detalhes["transcription"] ?? null) as Record<string, unknown> | null;

    const direto = typeof m["text"] === "string" ? m["text"] : "";
    const transcrito =
      transcricao && transcricao["error"] !== true && transcricao["processing"] !== true
        ? String(transcricao["text"] ?? "")
        : "";

    const texto = direto || transcrito;

    return {
      // Valores CRUS, sem interpretacao: e o que permite confirmar o
      // significado de `direction` em vez de supor.
      directionBruta: m["direction"] ?? null,
      userId: m["userId"] ?? null,
      senderId: m["senderId"] ?? null,
      origem: m["origin"] ?? null,
      quando: m["timestamp"] ?? m["createdAt"] ?? null,
      tipo: m["type"] ?? null,
      veioDeAudio: Boolean(transcrito),
      texto: texto ? mascararContato(texto) : "[sem texto]",
    };
  });

  /*
   * A checagem decisiva: a Central alcanca esta conversa?
   *
   * A varredura NAO comeca na pagina 1. A API entrega a listagem da conversa
   * mais ANTIGA para a mais nova, entao o adaptador le de tras para frente, a
   * partir de `totalPages`, ate no maximo 20 paginas de 50. Procurar pela
   * frente — como esta sonda fazia — respondia sempre "nao ve", porque as
   * primeiras paginas desta conta sao de outubro de 2025.
   */
  const primeira = await sondar(ENDPOINTS.SESSIONS.LIST, {
    query: { pageNumber: 1, pageSize: 50 },
  });

  const envelopePrimeira = (primeira.payload ?? {}) as Record<string, unknown>;
  const totalPaginas =
    typeof envelopePrimeira["totalPages"] === "number"
      ? (envelopePrimeira["totalPages"] as number)
      : 1;

  const MAX_PAGINAS = 20;

  let apareceNaVarredura = false;
  let paginaOndeApareceu: number | null = null;
  let paginasLidas = 0;

  for (
    let pagina = totalPaginas;
    pagina >= 1 && paginasLidas < MAX_PAGINAS;
    pagina -= 1
  ) {
    const lote =
      pagina === 1
        ? primeira
        : await sondar(ENDPOINTS.SESSIONS.LIST, {
            query: { pageNumber: pagina, pageSize: 50 },
          });

    paginasLidas += 1;

    const encontrada = (lote.itens ?? []).some(
      (item) => (item as Record<string, unknown>)["id"] === sessionId,
    );

    if (encontrada) {
      apareceNaVarredura = true;
      paginaOndeApareceu = pagina;
      break;
    }
  }

  return {
    conversa,
    audioCru: audioCru
      ? {
          campos: nomesDosCampos(audioCru),
          // O objeto inteiro, mascarado: e onde a transcricao deve estar.
          objeto: JSON.parse(
            mascararContato(JSON.stringify(audioCru)),
          ) as unknown,
        }
      : null,
    totalDeMensagens: falas.length,
    falas,
    diagnostico: {
      apareceNasPaginasQueACentralLe: apareceNaVarredura,
      paginaOndeApareceu,
      paginasLidas,
      totalPaginas,
      // Quantas paginas do FIM foram necessarias: e a distancia real entre
      // esta conversa e a borda recente da conta.
      distanciaDoFim:
        paginaOndeApareceu === null ? null : totalPaginas - paginaOndeApareceu + 1,
      observacao: apareceNaVarredura
        ? "A Central consegue ver esta conversa."
        : "A Central NAO ve esta conversa: ela esta fora das " +
          String(MAX_PAGINAS) +
          " ultimas paginas.",
    },
  };
}

export async function GET(request: NextRequest) {
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

  /**
   * `?adapters=1` mede o custo REAL de cada fonte da Central, em vez de uma
   * chamada isolada por endpoint. E o que responde "por que a pagina demora",
   * pergunta que a sonda normal nao alcanca.
   */
  const conversaPedida = request.nextUrl.searchParams.get("sessao");
  if (conversaPedida && /^[A-Za-z0-9_-]{1,128}$/.test(conversaPedida)) {
    return ok(
      { executado: true, modo: "sessao", ...(await abrirConversa(conversaPedida)) },
      { dataMode: readiness.dataMode },
    );
  }

  const painelPedido = request.nextUrl.searchParams.get("etapas");
  if (painelPedido && /^[A-Za-z0-9_-]{1,128}$/.test(painelPedido)) {
    return ok(
      { executado: true, modo: "etapas", ...(await procurarEtapas(painelPedido)) },
      { dataMode: readiness.dataMode },
    );
  }

  if (request.nextUrl.searchParams.get("ordem") === "1") {
    return ok(
      { executado: true, modo: "ordem", conversas: await medirOrdemDasConversas() },
      { dataMode: readiness.dataMode },
    );
  }

  if (request.nextUrl.searchParams.get("adapters") === "1") {
    const inicio = Date.now();
    const fontes = await medirAdapters("klipflowi", 12_000);

    return ok(
      { executado: true, modo: "adapters", totalMs: Date.now() - inicio, fontes },
      { dataMode: readiness.dataMode },
    );
  }

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
        // `steps` veio vazio ate no detalhe. O payload tem tambem
        // `stepTitles`; e preciso ver o que cada um realmente carrega antes
        // de decidir de onde o funil sai.
        stepsTipo: Array.isArray(painel["steps"])
          ? `array(${(painel["steps"] as unknown[]).length})`
          : typeof painel["steps"],
        stepTitlesTipo: Array.isArray(painel["stepTitles"])
          ? `array(${(painel["stepTitles"] as unknown[]).length})`
          : typeof painel["stepTitles"],
        stepTitles: painel["stepTitles"] ?? null,
        scope: painel["scope"] ?? null,
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
