import "server-only";
import type {
  AgentQualityReport,
  AppUser,
  ContactSnapshot,
  ConversationSnapshot,
  CrmCard,
  FunnelStepSummary,
  FunnelSummary,
  IntegrationSettings,
  IntelligenceFilters,
  IntelligenceKpis,
  MisplacedCard,
  Opportunity,
  Panel,
  Recommendation,
  Tag,
  TenantContext,
} from "@/domain/types";
import {
  agentsAdapter,
  cardsAdapter,
  contactsAdapter,
  messagesAdapter,
  panelsAdapter,
  sessionsAdapter,
  tagsAdapter,
} from "@/server/integration/adapters";
import { stepsFromCards } from "@/server/integration/adapters/panels.adapter";
import { shouldUseMock, type AdapterResult } from "@/server/integration/adapters/base";
import { ApiError } from "@/server/integration/http/client";
import { detectSignals } from "@/server/scoring/signals";
import { suggestionAcceptanceRate } from "./audit.service";
import {
  buildOpportunity,
  computeKpis,
  filterByVisibility,
} from "./opportunity.service";
import { buildQualityReport } from "./quality.service";
import { aiHabilitada, getConcorrencia, getModelo } from "@/server/ai/client";
import {
  analisarConversa,
  type ResultadoDaAnalise,
} from "@/server/ai/opportunity-analyst";
import { getSettings } from "./settings.service";

/**
 * Orquestrador da Central de Inteligencia Comercial.
 *
 * Carrega os snapshots pelos adapters, roda o motor de analise e devolve
 * tudo o que a interface precisa, ja filtrado pelo escopo do usuario.
 *
 * Nenhuma escrita acontece aqui: este servico so LE e ANALISA.
 */

/** Falha isolada de uma das fontes de dados. */
export interface SourceFailure {
  /** Nome legivel da fonte, como aparece para o usuario. */
  source: string;
  /** Endpoint envolvido, quando identificavel. */
  endpoint?: string;
  /** Classificacao do erro, para a interface orientar o que fazer. */
  kind: string;
  message: string;
}

export interface IntelligenceOverview {
  kpis: IntelligenceKpis;
  opportunities: Opportunity[];
  funnels: FunnelSummary[];
  qualityReports: AgentQualityReport[];
  recommendations: Recommendation[];
  settings: IntegrationSettings;
  lastAnalysisAt: string;
  dataMode: "mock" | "live";
  pendingValidation: string[];
  /**
   * Fontes que falharam sem derrubar a analise.
   *
   * A Central carrega seis fontes independentes. Deixar uma falha derrubar
   * todas produz uma tela de erro que nao diz nada — justamente no momento em
   * que o diagnostico mais importa: a primeira conexao com a API real.
   */
  sourceFailures: SourceFailure[];
  /** Quanto do periodo coube nesta analise. */
  coverage: AnalysisCoverage;
  /** Como a leitura por IA se comportou. Ausente quando ela nao esta ligada. */
  aiStats?: AiStats;
}

/**
 * Integridade da leitura por IA.
 *
 * `sinaisDescartados` e o numero que importa acompanhar: e quanto o modelo
 * tentou afirmar sem conseguir apontar onde na conversa aquilo foi dito. Zero
 * significa que ele se ateve ao texto. Um numero que cresce e sinal de que o
 * prompt afrouxou ou o modelo mudou — e como a barreira de verificacao roda
 * ANTES de qualquer coisa chegar a tela, o efeito nunca e uma oportunidade
 * falsa; e uma oportunidade a menos, que e o lado certo para errar.
 *
 * Sem esta contagem visivel, a barreira funcionaria em silencio e ninguem
 * saberia se ela esta sendo exercitada ou se virou codigo morto.
 */
export interface AiStats {
  /** Conversas que a IA efetivamente leu. */
  conversasLidas: number;
  /** Conversas que ficaram so com a deteccao deterministica. */
  conversasSemIa: number;
  sinaisAceitos: number;
  sinaisDescartados: number;
  /** Quantos descartes por motivo. */
  motivosDeDescarte: Record<string, number>;
  modelo: string;
}

/**
 * Abrangencia da analise.
 *
 * A API nao devolve as mensagens junto com a lista de conversas: e uma
 * chamada POR conversa. Analisar um periodo inteiro de uma conta movimentada
 * significaria centenas de chamadas em uma unica requisicao — foi assim que
 * a primeira tentativa contra a conta real estourou o tempo limite sem
 * devolver nada.
 *
 * Em vez de tentar tudo e falhar, o modulo analisa as conversas mais
 * recentes ate um teto e DIZ o que ficou de fora. Meia resposta honesta vale
 * mais do que uma tela de erro.
 */
export interface AnalysisCoverage {
  /** Conversas encontradas no periodo. */
  conversasNoPeriodo: number;
  /** Conversas efetivamente analisadas com as mensagens. */
  conversasAnalisadas: number;
  /** Teto aplicado nesta execucao. */
  teto: number;
  /** true quando alguma conversa do periodo ficou de fora. */
  truncado: boolean;
  /** true quando a analise parou por tempo, e nao por ter terminado. */
  interrompidaPorTempo: boolean;
  /** Milissegundos gastos em cada fase, para diagnostico. */
  tempos: Record<string, number>;
}

/**
 * Orcamento de tempo para as fases que fazem N chamadas.
 *
 * A funcao roda em ambiente serverless com limite de execucao. Sem orcamento,
 * uma conta movimentada leva a rota a ser morta no meio e a resposta vira um
 * erro sem nenhuma informacao — foi o que aconteceu na primeira chamada
 * contra a conta real. Com orcamento, ela devolve o que conseguiu analisar e
 * diz que parou por tempo.
 */
function orcamentoDeTempoMs(): number {
  const bruto = Number(process.env["FLW_TEMPO_MAXIMO_MS"]);
  // Zero e valido e significa "nao gaste tempo em leitura opcional": a
  // resposta sai so com o que ja estava carregado, dizendo que parou por
  // tempo. Util para diagnosticar e para desligar a varredura sem mexer em
  // codigo.
  //
  // 35 segundos, contra um `maxDuration` de 60.
  //
  // Os 25 anteriores foram calibrados quando so o carregamento levava 29
  // segundos; hoje ele leva cerca de 12, e o que sobrava nao dava nem para
  // uma leva de leitura da IA terminar. Mas esticar ate 45 e trocar um
  // problema por outro pior: a pagina passa de 50 segundos e fica a um
  // tropeco de bater no teto da plataforma, onde a resposta nao e parcial —
  // e nenhuma.
  //
  // 35 mantem a pagina em torno de 40 segundos com 20 de folga para a
  // serializacao e o arredondamento, e a fila de leitura converte esse
  // orcamento em cobertura muito melhor do que as levas convertiam.
  return Number.isFinite(bruto) && bruto >= 0 ? Math.floor(bruto) : 35_000;
}

/** Quantas conversas sao buscadas por vez, entre verificacoes do relogio. */
const LOTE = 8;



/**
 * Paginas de mensagens lidas por conversa na analise em massa.
 *
 * O padrao do adapter e 8 paginas — apropriado para abrir UMA conversa, e
 * ruinoso para varrer dezenas: 60 conversas x 8 paginas sao ate 480 chamadas
 * numa unica requisicao. Para detectar sinais de compra, as primeiras
 * mensagens ja trazem o pedido original e o essencial do contexto.
 */
const PAGINAS_DE_MENSAGEM_NA_VARREDURA = 2;

/**
 * Percorre uma fila com N trabalhadores em paralelo, respeitando um prazo.
 *
 * A alternativa — levas de tamanho fixo com uma checagem de relogio entre
 * elas — desperdica o orcamento de duas maneiras, ambas medidas contra a
 * conta real. A leva inteira espera pela conversa mais lenta, e a checagem
 * so acontece na fronteira: com 60 conversas em levas de 20, a primeira leva
 * levou 23 segundos, o prazo venceu na fronteira seguinte e 40 conversas
 * ficaram sem analise nenhuma — o orcamento tinha acabado, mas 19 dos 20
 * trabalhadores estavam ociosos ha segundos.
 *
 * Com uma fila, quem termina puxa o proximo item e o relogio e consultado
 * antes de cada item, nao a cada 20. O mesmo orcamento vira bem mais
 * cobertura, e o que sobra e informado em vez de sumir.
 */
export async function emParalelo<T, R>(
  itens: T[],
  trabalhadores: number,
  prazo: number,
  tarefa: (item: T) => Promise<R>,
): Promise<{ resultados: PromiseSettledResult<R>[]; naoIniciados: number }> {
  const resultados: PromiseSettledResult<R>[] = [];
  let proximo = 0;
  let naoIniciados = 0;

  async function trabalhar(): Promise<void> {
    for (;;) {
      const indice = proximo;
      proximo += 1;
      if (indice >= itens.length) return;

      const item = itens[indice];
      if (item === undefined) return;

      // O prazo e consultado por ITEM: uma conversa lenta nao decide o
      // destino das que ainda nem comecaram.
      if (Date.now() >= prazo) {
        naoIniciados += 1;
        continue;
      }

      try {
        resultados.push({ status: "fulfilled", value: await tarefa(item) });
      } catch (erro) {
        resultados.push({ status: "rejected", reason: erro });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(trabalhadores, itens.length)) }, trabalhar),
  );

  return { resultados, naoIniciados };
}

/** Divide uma lista em lotes de tamanho fixo. */
function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }
  return lotes;
}

/**
 * Teto de conversas analisadas por requisicao.
 *
 * 60 conversas ~ 60 chamadas de mensagens, que o limitador de vazao entrega
 * em poucos segundos. Ajustavel por ambiente para contas maiores rodando em
 * infraestrutura com mais tempo de execucao.
 */
function tetoDeConversas(): number {
  const bruto = Number(process.env["FLW_MAX_CONVERSAS"]);
  return Number.isFinite(bruto) && bruto > 0 ? Math.floor(bruto) : 60;
}

/** Dias sem movimentacao a partir dos quais um card conta como parado. */
const STALLED_DAYS = 7;

/**
 * Desempacota um resultado de `allSettled`, devolvendo um valor de reserva
 * quando a fonte falhou e registrando a falha para exibicao.
 */
function unwrap<T>(
  settled: PromiseSettledResult<AdapterResult<T>>,
  source: string,
  fallback: T,
  failures: SourceFailure[],
): AdapterResult<T> {
  if (settled.status === "fulfilled") return settled.value;

  const error = settled.reason;
  const apiError = error instanceof ApiError ? error : undefined;

  failures.push({
    source,
    endpoint: apiError?.endpointKey,
    kind: apiError?.kind ?? "ERRO_INTERNO",
    message: error instanceof Error ? error.message : String(error),
  });

  return { data: fallback, source: "live", pendingValidation: [] };
}

export async function loadOverview(params: {
  context: TenantContext;
  filters: IntelligenceFilters;
  now?: Date;
  /**
   * Desliga a leitura por IA nesta execucao.
   *
   * Existe para comparar os dois motores sobre os MESMOS dados. Sem isso, a
   * unica forma de avaliar o que a IA acrescenta e comparar com uma medicao
   * antiga — e entre uma e outra outras correcoes entraram, o que faz o
   * credito ir parar no lugar errado. Uma medicao que nao isola a variavel
   * nao mede nada.
   */
  semIa?: boolean;
}): Promise<IntelligenceOverview> {
  const now = params.now ?? new Date();
  const { context, filters } = params;
  const accountId = context.accountId;
  const pending = new Set<string>();

  const collect = (messages: string[]) => messages.forEach((m) => pending.add(m));

  /* --- Carregamento paralelo dos snapshots -------------------------------
   * `allSettled` em vez de `all`: se os paineis falharem, ainda queremos
   * mostrar as oportunidades das conversas, dizendo claramente o que faltou.
   */
  const sourceFailures: SourceFailure[] = [];

  const inicio = Date.now();
  const prazo = inicio + orcamentoDeTempoMs();
  const tempos: Record<string, number> = {};
  const marcar = (fase: string, desde: number) => {
    tempos[fase] = Date.now() - desde;
  };

  const inicioSnapshots = Date.now();

  const [sessionsSettled, contactsSettled, panelsSettled, usersSettled, tagsSettled] =
    await Promise.allSettled([
      sessionsAdapter.list({
        accountId,
        updatedAfter: filters.period.from,
        // Margem sobre o teto: parte das conversas cai fora do escopo do
        // usuario ou do filtro de equipe, entao vale trazer um pouco mais.
        limite: Math.ceil(tetoDeConversas() * 1.5),
      }),
      /*
       * Contatos NAO sao carregados em massa no modo real.
       *
       * A conta tem 14.239 contatos. Ler 10 paginas trazia 500 — e, como a
       * ordem da API e crescente, eram os 500 MAIS ANTIGOS: justamente os que
       * nao aparecem nas conversas recentes. Custava segundos do orcamento
       * para quase sempre errar o alvo.
       *
       * Os contatos das conversas analisadas sao buscados por id logo abaixo,
       * que e o caminho que ja existia como complemento e agora e o unico.
       */
      shouldUseMock()
        ? contactsAdapter.list({ accountId })
        : Promise.resolve({ data: [], source: "live" as const, pendingValidation: [] }),
      panelsAdapter.list({ accountId }),
      agentsAdapter.list({ accountId }),
      tagsAdapter.list({ accountId }),
    ]);

  marcar("snapshots", inicioSnapshots);

  const sessionsRes = unwrap(sessionsSettled, "Conversas", [], sourceFailures);
  const contactsRes = unwrap(contactsSettled, "Contatos", [], sourceFailures);
  const panelsRes = unwrap(panelsSettled, "Painéis do CRM", [], sourceFailures);
  const usersRes = unwrap(usersSettled, "Usuários", [], sourceFailures);
  const tagsRes = unwrap(tagsSettled, "Etiquetas", [], sourceFailures);

  /*
   * Os cards vem DEPOIS dos paineis, e nao em paralelo, porque a API exige o
   * painel na listagem ("The PanelId field is required."). Nao ha como pedir
   * "todos os cards da conta" numa chamada so.
   *
   * E so os paineis de VENDAS sao varridos. A conta sondada tem 20 paineis,
   * 18 deles quadros pessoais de tarefas ("Minhas tarefas"): varrer todos
   * custaria 20 chamadas para trazer cards que nao sao oportunidade
   * comercial nenhuma, e ainda poluiria o funil com tarefas internas.
   *
   * Se os paineis falharem, a lista de cards fica vazia — o que ja esta
   * registrado em `sourceFailures` pela falha dos paineis. Repetir a mesma
   * falha como se fossem duas so confundiria quem le o aviso.
   */
  const painelDeVendasIds = panelsRes.data
    .filter((panel) => panel.type === "SALES")
    .map((panel) => panel.id);

  const inicioCards = Date.now();
  const [cardsSettled] = await Promise.allSettled([
    cardsAdapter.listForPanels({ accountId, panelIds: painelDeVendasIds }),
  ]);
  marcar("cards", inicioCards);

  const cardsRes = unwrap(cardsSettled, "Cards do CRM", [], sourceFailures);

  /*
   * Sem usuarios nao ha como resolver perfil nem escopo de visibilidade —
   * e sem isso qualquer resposta seria insegura. Esta e a unica fonte cuja
   * falha derruba a analise inteira, e de proposito.
   */
  if (usersSettled.status === "rejected") {
    throw usersSettled.reason;
  }

  collect(sessionsRes.pendingValidation);
  collect(contactsRes.pendingValidation);
  collect(panelsRes.pendingValidation);
  collect(cardsRes.pendingValidation);
  collect(usersRes.pendingValidation);
  collect(tagsRes.pendingValidation);

  const cards = cardsRes.data;

  /*
   * Etapas do funil deduzidas dos cards, quando o painel nao as traz.
   *
   * A API devolve `steps: null` nos dois paineis de vendas desta conta —
   * tanto na listagem quanto no detalhe. Sem isto, o funil apareceria vazio
   * e nenhuma oportunidade receberia sugestao de proxima etapa: a Central
   * perderia uma das seis abas sem dizer por que.
   *
   * O que a deducao NAO faz, e precisa ser dito: etapa sem nenhum card nao
   * aparece, e a ordem entre etapas e apenas a de aparicao.
   */
  const panels = panelsRes.data.map((panel) => {
    if (panel.steps.length > 0) return panel;

    const doPainel = cards.filter((card) => card.panelId === panel.id);
    const deduzidas = stepsFromCards(doPainel);
    if (deduzidas.length === 0) return panel;

    pending.add(
      `Painel "${panel.name}": a API nao devolveu as etapas, entao elas foram ` +
        `deduzidas dos ${doPainel.length} card(s) existentes. Etapas sem nenhum ` +
        `card nao aparecem, e a ordem entre elas e a de aparicao.`,
    );

    return { ...panel, steps: deduzidas };
  });
  const users = usersRes.data;
  const settings = getSettings(accountId);

  /* --- Carrega mensagens de cada conversa --------------------------------
   * No modo simulado as mensagens ja vem embutidas; no modo real sao buscadas
   * POR CONVERSA — a API nao tem como devolver as mensagens de varias de uma
   * vez. Isso torna o custo proporcional ao numero de conversas, entao o
   * trabalho e limitado a um teto, priorizando as mais recentes: uma conversa
   * de hoje diz mais sobre o que fazer agora do que uma de tres semanas atras.
   */
  const teto = tetoDeConversas();

  /*
   * O PERIODO E APLICADO ANTES DO TETO — e a ordem importa.
   *
   * Antes era o contrario: pegava as 60 conversas mais recentes da conta e so
   * depois filtrava pelo periodo. Pedir um dia especifico devolvia zero
   * oportunidades sempre que aquele dia nao estivesse entre as 60 ultimas da
   * conta — mesmo havendo conversas nele. A tela dizia "nenhuma oportunidade"
   * quando a resposta certa era "voce nao olhou".
   *
   * Filtrando primeiro, o teto passa a limitar o que existe DENTRO do recorte
   * pedido, que e o que qualquer pessoa espera ao escolher um periodo.
   */
  const periodoDe = Date.parse(filters.period.from);
  const periodoAte = Date.parse(filters.period.to);

  const noPeriodo = sessionsRes.data.filter((conversa) => {
    const ultima = Date.parse(conversa.lastMessageAt);
    return Number.isFinite(ultima) && ultima >= periodoDe && ultima <= periodoAte;
  });

  const porRecencia = [...noPeriodo].sort(
    (a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt),
  );
  const selecionadas = porRecencia.slice(0, teto);

  /*
   * Busca em lotes, conferindo o relogio entre um e outro.
   *
   * `Promise.allSettled` sobre a lista inteira nao permite parar no meio: ou
   * termina, ou a funcao e morta e nada e devolvido. Em lotes, quando o
   * orcamento acaba, as conversas ja buscadas continuam valendo e as demais
   * entram na analise sem mensagens — com score reduzido e dito na resposta.
   */
  const inicioMensagens = Date.now();
  const conversations: ConversationSnapshot[] = [];
  let mensagensComFalha = 0;
  let interrompidaPorTempo = false;
  let comMensagens = 0;

  for (const lote of emLotes(selecionadas, LOTE)) {
    if (Date.now() >= prazo) {
      interrompidaPorTempo = true;
      conversations.push(...lote);
      continue;
    }

    const resultados = await Promise.allSettled(
      lote.map(async (session) => {
        if (session.messages.length > 0) return session;

        const messagesRes = await messagesAdapter.listBySession({
          accountId,
          sessionId: session.id,
          maxPages: PAGINAS_DE_MENSAGEM_NA_VARREDURA,
        });
        collect(messagesRes.pendingValidation);
        return { ...session, messages: messagesRes.data };
      }),
    );

    // Uma conversa cujas mensagens nao carregaram e analisada sem elas — o
    // que resulta em score baixo — em vez de impedir a analise das outras.
    resultados.forEach((resultado, indice) => {
      if (resultado.status === "fulfilled") {
        conversations.push(resultado.value);
        if (resultado.value.messages.length > 0) comMensagens += 1;
        return;
      }
      mensagensComFalha += 1;
      const original = lote[indice];
      if (original) conversations.push(original);
    });
  }

  marcar("mensagens", inicioMensagens);

  const coverage: AnalysisCoverage = {
    conversasNoPeriodo: noPeriodo.length,
    conversasAnalisadas: comMensagens,
    teto,
    truncado: noPeriodo.length > selecionadas.length,
    interrompidaPorTempo,
    tempos,
  };

  if (coverage.truncado) {
    pending.add(
      `Analisadas as ${selecionadas.length} conversas mais recentes de ` +
        `${coverage.conversasNoPeriodo} no periodo. Reduza o periodo para cobrir ` +
        `tudo, ou aumente FLW_MAX_CONVERSAS se a infraestrutura permitir.`,
    );
  }

  if (interrompidaPorTempo) {
    pending.add(
      `A analise parou no limite de tempo: ${coverage.conversasAnalisadas} de ` +
        `${selecionadas.length} conversas tiveram as mensagens lidas. As demais ` +
        `aparecem com score reduzido. Reduza o periodo ou ajuste ` +
        `FLW_TEMPO_MAXIMO_MS / FLW_MAX_CONVERSAS.`,
    );
  }

  if (mensagensComFalha > 0) {
    sourceFailures.push({
      source: "Mensagens",
      kind: "PARCIAL",
      message:
        `Nao foi possivel carregar as mensagens de ${mensagensComFalha} de ` +
        `${selecionadas.length} conversa(s). Elas aparecem com score reduzido ` +
        `por falta de conteudo para analisar.`,
    });
  }

  /* --- Completa os contatos das conversas analisadas ---------------------
   * A listagem de contatos e paginada e limitada: em uma conta com milhares
   * de contatos, o contato da conversa que estamos analisando pode
   * simplesmente nao estar na parte que foi lida. O sintoma seria pessimo e
   * discreto — o card apareceria como "Contato", sem etiquetas e sem
   * historico, como se o cliente fosse novo.
   *
   * Entao, para as conversas selecionadas, o que faltar e buscado por id.
   * O custo e limitado pelo mesmo teto das conversas.
   */
  const contatosPorId = new Map(contactsRes.data.map((contact) => [contact.id, contact]));

  const faltando = [
    ...new Set(
      conversations
        .map((c) => c.contactId)
        .filter((id): id is string => Boolean(id) && !contatosPorId.has(id)),
    ),
  ];

  if (faltando.length > 0) {
    const inicioContatos = Date.now();
    let contatosComFalha = 0;
    let contatosNaoBuscados = 0;

    for (const lote of emLotes(faltando, LOTE)) {
      if (Date.now() >= prazo) {
        contatosNaoBuscados += lote.length;
        continue;
      }

      const buscados = await Promise.allSettled(
        lote.map((contactId) => contactsAdapter.getById({ accountId, contactId })),
      );

      for (const resultado of buscados) {
        if (resultado.status === "rejected") {
          contatosComFalha += 1;
          continue;
        }
        collect(resultado.value.pendingValidation);
        const contato = resultado.value.data;
        if (contato) contatosPorId.set(contato.id, contato);
      }
    }

    marcar("contatos", inicioContatos);

    if (contatosNaoBuscados > 0) {
      coverage.interrompidaPorTempo = true;
      pending.add(
        `${contatosNaoBuscados} contato(s) nao foram carregados por limite de ` +
          `tempo. Essas oportunidades aparecem sem etiquetas nem historico.`,
      );
    }

    if (contatosComFalha > 0) {
      sourceFailures.push({
        source: "Contatos",
        kind: "PARCIAL",
        message:
          `Nao foi possivel carregar ${contatosComFalha} contato(s) referenciado(s) ` +
          `pelas conversas analisadas. Essas oportunidades aparecem sem etiquetas ` +
          `nem historico do cliente.`,
      });
    }
  }

  const contacts = [...contatosPorId.values()];


  /*
   * A busca acabou; daqui para a frente e so analise.
   *
   * A separacao existe para que uma segunda fonte de conversas — a planilha
   * exportada da KlipFlowi — use exatamente o mesmo motor, em vez de ganhar
   * uma copia dele que envelhece em paralelo.
   */
  return analisarConjunto({
    dados: {
      conversations,
      contacts,
      cards,
      panels,
      users,
      tags: tagsRes.data,
      settings,
    },
    context,
    filters,
    now,
    semIa: params.semIa,
    coleta: { coverage, sourceFailures, pending: [...pending], prazo },
  });
}

/**
 * Quais modelos efetivamente leram as conversas desta execucao.
 *
 * Quase sempre um so. Vira dois quando o provedor principal recusou no meio
 * da varredura e a leitura caiu para o reserva — e e justamente ai que o
 * campo precisa dizer a verdade, porque e a unica pista visivel de que o
 * principal parou.
 */
function modelosQueLeram(analises: Map<string, ResultadoDaAnalise>): string {
  const vistos = new Set<string>();

  for (const analise of analises.values()) {
    if (analise.modelo) vistos.add(analise.modelo);
  }

  return vistos.size > 0 ? [...vistos].sort().join(" + ") : getModelo();
}

/* ==========================================================================
   Motor de analise
   ========================================================================== */

/** Tudo que o motor precisa para analisar, ja carregado. */
export interface DadosParaAnalise {
  /** Conversas com as mensagens JA embutidas. */
  conversations: ConversationSnapshot[];
  contacts: ContactSnapshot[];
  cards: CrmCard[];
  panels: Panel[];
  users: AppUser[];
  /** Etiquetas da conta: e delas que saem as sugestoes aplicaveis. */
  tags: Tag[];
  settings: IntegrationSettings;
}

/**
 * O que a fase de busca descobriu sobre a propria busca.
 *
 * Quem carregou os dados sabe coisas que o motor nao tem como deduzir: que o
 * periodo tinha 547 conversas e so 60 couberam, que os paineis falharam, que
 * o relogio estourou no meio. Sem isso a analise diria "60 conversas" como se
 * fossem todas, que e a diferenca entre meia resposta honesta e uma resposta
 * errada.
 */
export interface EstadoDaColeta {
  coverage: AnalysisCoverage;
  sourceFailures: SourceFailure[];
  pending: string[];
  /** Instante limite para as fases que fazem N chamadas (a leitura por IA). */
  prazo: number;
}

/**
 * Analisa um conjunto de conversas ja carregadas. NAO chama a API.
 *
 * Esta funcao era o segundo terco de `loadOverview`, misturada com a busca.
 * Separa-las nao foi arrumacao: e o que permite alimentar o mesmo motor por
 * uma planilha exportada da KlipFlowi sem duplicar score, deteccao de sinais,
 * verificacao de evidencia, funil, qualidade e indicadores — seis coisas que
 * nao podem divergir entre as duas entradas.
 *
 * Sem `coleta`, assume que as conversas recebidas sao tudo que havia: e o caso
 * da planilha, onde o recorte foi decidido por quem exportou.
 */
export async function analisarConjunto(params: {
  dados: DadosParaAnalise;
  context: TenantContext;
  filters: IntelligenceFilters;
  now?: Date;
  semIa?: boolean;
  coleta?: Partial<EstadoDaColeta>;
}): Promise<IntelligenceOverview> {
  const { context, filters, semIa } = params;
  const { conversations, contacts, cards, panels, users, tags, settings } = params.dados;

  const now = params.now ?? new Date();
  const accountId = context.accountId;

  const sourceFailures: SourceFailure[] = params.coleta?.sourceFailures ?? [];
  const pending = new Set<string>(params.coleta?.pending ?? []);
  const prazo = params.coleta?.prazo ?? Date.now() + orcamentoDeTempoMs();

  const coverage: AnalysisCoverage = params.coleta?.coverage ?? {
    conversasNoPeriodo: conversations.length,
    conversasAnalisadas: conversations.length,
    teto: conversations.length,
    truncado: false,
    interrompidaPorTempo: false,
    tempos: {},
  };

  // Mesma referencia que a fase de busca ja vinha preenchendo: os tempos das
  // fases anteriores continuam aparecendo ao lado do tempo da IA.
  const tempos = coverage.tempos;
  const marcar = (fase: string, desde: number) => {
    tempos[fase] = Date.now() - desde;
  };

  const periodoDe = Date.parse(filters.period.from);
  const periodoAte = Date.parse(filters.period.to);
  /* --- Aplica filtros de equipe e vendedor -------------------------------
   * O periodo ja foi aplicado antes do teto; a checagem segue aqui de
   * proposito, barata, para que uma futura mudanca de ordem nao deixe passar
   * conversa fora do recorte.
   */
  const periodFrom = periodoDe;
  const periodTo = periodoAte;

  const teamMemberIds = filters.teamId
    ? new Set(users.filter((u) => u.teamId === filters.teamId).map((u) => u.id))
    : null;

  const inScope = conversations.filter((conversation) => {
    const last = Date.parse(conversation.lastMessageAt);
    if (!Number.isFinite(last) || last < periodFrom || last > periodTo) return false;

    if (teamMemberIds && conversation.agentId && !teamMemberIds.has(conversation.agentId)) {
      return false;
    }
    if (filters.agentId && conversation.agentId !== filters.agentId) return false;

    return true;
  });

  /* --- Constroi as oportunidades ----------------------------------------- */
  const built: Opportunity[] = [];

  /*
   * Leitura por IA, quando configurada.
   *
   * Vem antes da montagem porque os sinais que o modelo encontra sao insumo
   * do MESMO motor de score. Segue os limites que ja protegem a varredura:
   * lotes, relogio e degradacao silenciosa — se a IA falhar, a analise
   * deterministica continua, e a falha aparece nomeada em vez de virar uma
   * tela vazia.
   */
  const inicioIa = Date.now();
  const analises = new Map<string, ResultadoDaAnalise>();
  let iaComFalha = 0;
  let iaNaoAnalisadas = 0;
  let primeiraFalhaDaIa: string | undefined;
  let sinaisAceitos = 0;
  let sinaisDescartados = 0;
  const motivosDeDescarte: Record<string, number> = {};

  const usarIa = aiHabilitada() && !semIa;

  if (usarIa) {
    const { resultados, naoIniciados } = await emParalelo(
      inScope,
      getConcorrencia(),
      prazo,
      async (conversation) => {
        const contato = contacts.find((c) => c.id === conversation.contactId);
        const analise = await analisarConversa({
          conversation,
          contactName: contato?.name ?? "cliente",
        });
        return { id: conversation.id, analise };
      },
    );

    iaNaoAnalisadas += naoIniciados;

    for (const resultado of resultados) {
      if (resultado.status === "rejected") {
        iaComFalha += 1;
        const motivo =
          resultado.reason instanceof Error
            ? resultado.reason.message
            : String(resultado.reason);
        primeiraFalhaDaIa ??= motivo;
        continue;
      }
      if (resultado.value.analise) {
        const analise = resultado.value.analise;
        analises.set(resultado.value.id, analise);

        sinaisAceitos += analise.sinais.length;
        sinaisDescartados += analise.descartados.length;
        for (const descarte of analise.descartados) {
          motivosDeDescarte[descarte.motivo] =
            (motivosDeDescarte[descarte.motivo] ?? 0) + 1;
        }
      }
    }

    marcar("ia", inicioIa);

    if (iaComFalha > 0) {
      sourceFailures.push({
        source: "Análise por IA",
        kind: "PARCIAL",
        message:
          `A IA não conseguiu ler ${iaComFalha} de ${inScope.length} conversa(s). ` +
          `Elas foram analisadas apenas pela detecção determinística. ` +
          `Primeira falha: ${primeiraFalhaDaIa ?? "desconhecida"}`,
      });
    }

    if (sinaisDescartados > 0) {
      pending.add(
        `A IA citou ${sinaisDescartados} trecho(s) que nao existem nas conversas; ` +
          `esses sinais foram descartados antes de chegar a tela. ` +
          `${sinaisAceitos} sinal(is) com evidencia verificada foram aceitos.`,
      );
    }

    if (iaNaoAnalisadas > 0) {
      pending.add(
        `${iaNaoAnalisadas} conversa(s) não passaram pela IA por limite de tempo. ` +
          `Elas aparecem com a leitura determinística, que é mais conservadora.`,
      );
    }
  }

  for (const conversation of inScope) {
    const contact = contacts.find((c) => c.id === conversation.contactId);
    const existingCard = cards.find(
      (card) =>
        card.sessionId === conversation.id ||
        (card.contactId === conversation.contactId && card.status === "OPEN"),
    );

    const previousCount = conversations.filter(
      (c) => c.contactId === conversation.contactId && c.id !== conversation.id,
    ).length;

    const analise = analises.get(conversation.id);

    const opportunity = buildOpportunity({
      conversation,
      contact,
      existingCard,
      previousConversationCount: previousCount,
      panels,
      settings,
      // As etiquetas da conta ja foram lidas para a Central; e delas que saem
      // as sugestoes aplicaveis ao contato.
      accountTags: tags,
      now,
      ...(analise
        ? {
            aiAnalysis: {
              icp: analise.icp,
              sinais: analise.sinais,
              objecoes: analise.objecoes,
              resumoDaNecessidade: analise.resumoDaNecessidade,
              ...(analise.produtoDeInteresse
                ? { produtoDeInteresse: analise.produtoDeInteresse }
                : {}),
              proximoPasso: analise.proximoPasso,
              ...(analise.valorMencionado !== undefined
                ? { valorMencionado: analise.valorMencionado }
                : {}),
            },
          }
        : {}),
    });

    if (opportunity) built.push(opportunity);
  }

  /* --- Escopo de visibilidade e filtros finais --------------------------- */
  let opportunities = filterByVisibility(built, context);

  if (filters.priority) {
    opportunities = opportunities.filter((o) => o.priority === filters.priority);
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    opportunities = opportunities.filter(
      (o) =>
        o.contactName.toLowerCase().includes(needle) ||
        (o.company?.toLowerCase().includes(needle) ?? false) ||
        o.needSummary.toLowerCase().includes(needle),
    );
  }

  opportunities.sort(
    (a, b) => b.score - a.score || b.confidence - a.confidence || a.contactName.localeCompare(b.contactName),
  );

  /* --- Funil -------------------------------------------------------------- */
  const funnels = buildFunnels({ panels, cards, opportunities, now });

  /* --- Qualidade dos atendimentos ---------------------------------------- */
  const visibleAgentIds =
    context.visibleAgentIds === "ALL"
      ? [...new Set(inScope.map((c) => c.agentId).filter((id): id is string => Boolean(id)))]
      : context.visibleAgentIds;

  const opportunitySessionIds = new Set(opportunities.map((o) => o.sessionId));

  const qualityReports = visibleAgentIds
    .map((agentId) => {
      const user = users.find((u) => u.id === agentId);
      const agentConversations = inScope.filter((c) => c.agentId === agentId);
      if (agentConversations.length === 0) return null;

      /*
       * O nome do atendente tem duas fontes, e a segunda importa.
       *
       * O cadastro de usuarios e a fonte preferida, mas nem todo `userId` de
       * conversa aparece nele (atendente desligado, usuario de outra conta
       * vinculada, paginacao do cadastro). Quando isso acontecia, o relatorio
       * de qualidade estampava o UUID cru no lugar do nome — ilegivel para
       * quem precisa reconhecer a propria equipe. A propria conversa carrega
       * `agentDetails.name`, entao usamos esse nome antes de desistir e
       * mostrar o identificador.
       */
      const nomeNaConversa = agentConversations.find((c) => c.agentName)?.agentName;

      return buildQualityReport({
        agentId,
        agentName: user?.name ?? nomeNaConversa ?? agentId,
        teamName: user?.teamName,
        conversations: agentConversations,
        cards: cards.filter((c) => c.responsibleId === agentId),
        opportunitySessionIds: new Set(
          agentConversations.map((c) => c.id).filter((id) => opportunitySessionIds.has(id)),
        ),
      });
    })
    .filter((r): r is AgentQualityReport => r !== null)
    .sort((a, b) => b.overallScore - a.overallScore);

  /* --- Indicadores -------------------------------------------------------- */
  const contactsWithoutTags = contacts.filter((c) => c.tagIds.length === 0).length;

  const conversationsWithBuyingIntent = inScope.filter((conversation) =>
    detectSignals(conversation.messages).some((s) => s.polarity === "POSITIVE"),
  ).length;

  // "Recuperadas pela IA": oportunidades relevantes que NAO tinham card e que
  // estavam sem retorno — ou seja, que teriam passado despercebidas.
  const recoveredByAi = opportunities.filter(
    (o) => !o.cardId && o.hoursWithoutReply >= 24 && o.score >= 50,
  ).length;

  const kpis = computeKpis({
    opportunities,
    cards,
    panels,
    contactsWithoutTags,
    conversationsWithBuyingIntent,
    recoveredByAi,
    acceptanceRate: suggestionAcceptanceRate(accountId),
    now,
  });

  return {
    kpis,
    opportunities,
    funnels,
    qualityReports,
    recommendations: buildRecommendations({ opportunities, funnels, kpis, accountId }),
    settings,
    lastAnalysisAt: now.toISOString(),
    dataMode: shouldUseMock() ? "mock" : "live",
    pendingValidation: [...pending],
    sourceFailures,
    coverage,
    ...(usarIa
      ? {
          aiStats: {
            conversasLidas: analises.size,
            conversasSemIa: inScope.length - analises.size,
            sinaisAceitos,
            sinaisDescartados,
            motivosDeDescarte,
            // Quem REALMENTE leu, nao quem foi configurado: com reserva, a
            // leitura pode ter caido para o outro provedor no meio da
            // varredura. Reportar o configurado esconderia exatamente o que
            // se quer saber — que o principal parou.
            modelo: modelosQueLeram(analises),
          },
        }
      : {}),
  };
}

/* ==========================================================================
   Funil
   ========================================================================== */
function buildFunnels(params: {
  panels: Panel[];
  cards: CrmCard[];
  opportunities: Opportunity[];
  now: Date;
}): FunnelSummary[] {
  const { panels, cards, opportunities, now } = params;

  return panels.map((panel) => {
    const panelCards = cards.filter((c) => c.panelId === panel.id);

    const steps: FunnelStepSummary[] = panel.steps.map((step) => {
      const stepCards = panelCards.filter((c) => c.stepId === step.id && c.status === "OPEN");

      return {
        stepId: step.id,
        stepName: step.name,
        order: step.order,
        cardCount: stepCards.length,
        totalValue: stepCards.reduce((acc, c) => acc + (c.amount ?? 0), 0),
        stalledCount: stepCards.filter(
          (c) => now.getTime() - Date.parse(c.updatedAt) > STALLED_DAYS * 24 * 36e5,
        ).length,
      };
    });

    const misplacedCards: MisplacedCard[] = [];

    for (const card of panelCards) {
      if (card.status !== "OPEN") continue;

      const opportunity = opportunities.find((o) => o.cardId === card.id);
      if (!opportunity?.recommendedStepName) continue;

      const currentStep = panel.steps.find((s) => s.id === card.stepId);
      if (!currentStep || currentStep.name === opportunity.recommendedStepName) continue;

      misplacedCards.push({
        cardId: card.id,
        title: card.title,
        currentStepName: currentStep.name,
        recommendedStepName: opportunity.recommendedStepName,
        reason:
          `A conversa indica ${opportunity.evidence
            .slice(0, 2)
            .map((e) => e.label.toLowerCase())
            .join(" e ") || "avanco comercial"}, compativel com a etapa recomendada.`,
        confidence: opportunity.confidence,
      });
    }

    return {
      panelId: panel.id,
      panelName: panel.name,
      panelType: panel.type,
      steps,
      misplacedCards,
    };
  });
}

/* ==========================================================================
   Recomendacoes
   ========================================================================== */
function buildRecommendations(params: {
  opportunities: Opportunity[];
  funnels: FunnelSummary[];
  kpis: IntelligenceKpis;
  accountId: string;
}): Recommendation[] {
  const { opportunities, funnels, kpis, accountId } = params;
  const out: Recommendation[] = [];

  const withoutReply = opportunities.filter((o) => o.hoursWithoutReply >= 24 && o.score >= 50);
  if (withoutReply.length > 0) {
    out.push({
      id: "rec_sem_retorno",
      accountId,
      title: "Responder clientes que ficaram sem retorno",
      description:
        `${withoutReply.length} cliente(s) com sinal de compra estao ha mais de 24h ` +
        `aguardando resposta. Este e o grupo com maior chance de recuperacao imediata.`,
      impact: "ALTO",
      effort: "BAIXO",
      category: "FOLLOWUP",
      affectedCount: withoutReply.length,
      evidenceSummary: `Score medio ${Math.round(
        withoutReply.reduce((a, o) => a + o.score, 0) / withoutReply.length,
      )}/100 no grupo.`,
      relatedOpportunityIds: withoutReply.slice(0, 10).map((o) => o.id),
    });
  }

  const unregistered = opportunities.filter((o) => !o.cardId && o.score >= 50);
  if (unregistered.length > 0) {
    out.push({
      id: "rec_sem_card",
      accountId,
      title: "Registrar oportunidades que nao estao no CRM",
      description:
        `${unregistered.length} oportunidade(s) relevante(s) existem apenas na conversa ` +
        `e nao tem card no funil. Sem registro, elas nao entram em nenhuma previsao.`,
      impact: "ALTO",
      effort: "BAIXO",
      category: "DADOS",
      affectedCount: unregistered.length,
      evidenceSummary: (() => {
        const soma = unregistered.reduce((a, o) => a + (o.estimatedValue ?? 0), 0);
        const semValor = unregistered.filter((o) => o.estimatedValue === undefined).length;

        // Dizer "R$ 0,00" faria a recomendacao parecer irrelevante quando na
        // verdade o valor apenas ainda nao foi estimado em nenhuma conversa.
        if (soma === 0) {
          return `Nenhuma delas tem valor estimado ainda — justamente por nao ` +
            `estarem registradas no funil.`;
        }
        const formatado = soma.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
        return semValor > 0
          ? `Valor potencial somado: ${formatado}, sem contar ${semValor} sem valor estimado.`
          : `Valor potencial somado: ${formatado}.`;
      })(),
      relatedOpportunityIds: unregistered.slice(0, 10).map((o) => o.id),
    });
  }

  const misplaced = funnels.flatMap((f) => f.misplacedCards);
  if (misplaced.length > 0) {
    out.push({
      id: "rec_etapa_errada",
      accountId,
      title: "Corrigir cards que parecem estar na etapa errada",
      description:
        `${misplaced.length} card(s) estao em uma etapa que nao corresponde ao ` +
        `estagio real da conversa. Isso distorce a previsao de fechamento.`,
      impact: "MEDIO",
      effort: "BAIXO",
      category: "FUNIL",
      affectedCount: misplaced.length,
      evidenceSummary: misplaced
        .slice(0, 3)
        .map((c) => `${c.title}: ${c.currentStepName} -> ${c.recommendedStepName}`)
        .join(" | "),
      relatedOpportunityIds: [],
    });
  }

  const repurchase = opportunities.filter((o) => o.recommendedTagKeys.includes("RECOMPRA"));
  if (repurchase.length > 0) {
    out.push({
      id: "rec_recompra",
      accountId,
      title: "Trabalhar clientes em ciclo de recompra",
      description:
        `${repurchase.length} cliente(s) recorrente(s) sinalizaram reposicao. ` +
        `Costuma ser o ciclo de venda mais curto e com maior taxa de conversao.`,
      impact: "ALTO",
      effort: "BAIXO",
      category: "RECOMPRA",
      affectedCount: repurchase.length,
      evidenceSummary: repurchase.slice(0, 3).map((o) => o.contactName).join(", "),
      relatedOpportunityIds: repurchase.map((o) => o.id),
    });
  }

  if (kpis.contatosSemClassificacao > 0) {
    out.push({
      id: "rec_sem_classificacao",
      accountId,
      title: "Classificar contatos sem etiqueta",
      description:
        `${kpis.contatosSemClassificacao} contato(s) nao tem nenhuma etiqueta. ` +
        `Sem classificacao, eles ficam de fora de qualquer segmentacao ou campanha.`,
      impact: "MEDIO",
      effort: "BAIXO",
      category: "DADOS",
      affectedCount: kpis.contatosSemClassificacao,
      evidenceSummary: "Contagem apurada sobre a base de contatos da conta.",
      relatedOpportunityIds: [],
    });
  }

  const stalled = funnels
    .flatMap((f) => f.steps)
    .filter((s) => s.stalledCount > 0)
    .sort((a, b) => b.stalledCount - a.stalledCount);

  if (stalled.length > 0 && stalled[0]) {
    const worst = stalled[0];
    out.push({
      id: "rec_etapa_represada",
      accountId,
      title: `Destravar a etapa "${worst.stepName}"`,
      description:
        `${worst.stalledCount} card(s) estao parados ha mais de ${STALLED_DAYS} dias nesta etapa, ` +
        `somando ${worst.totalValue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}. ` +
        `E onde o funil esta represando mais valor.`,
      impact: "ALTO",
      effort: "MEDIO",
      category: "FUNIL",
      affectedCount: worst.stalledCount,
      evidenceSummary: `Etapa com maior numero de cards sem movimentacao.`,
      relatedOpportunityIds: [],
    });
  }

  const impactOrder = { ALTO: 0, MEDIO: 1, BAIXO: 2 } as const;
  return out.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact]);
}
