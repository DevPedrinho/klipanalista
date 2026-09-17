import "server-only";
import type { CardStatus } from "@/domain/enums";
import type { CardNote, CrmCard, StepPhase } from "@/domain/types";
import { MOCK_CARDS, findCardByContact } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import {
  MappingReport,
  readBoolean,
  readDate,
  readIdList,
  readNumber,
  readRecord,
  readString,
} from "../mappers/tolerant";
import {
  buildIdempotencyKey,
  liveResult,
  mockResult,
  shouldUseMock,
  type AdapterResult,
} from "./base";

/**
 * CardsAdapter — cards do CRM.
 *
 * Endpoints CONFIRMADOS:
 *   GET  /v2/panel/card                        Listagem paginada
 *   POST /v2/panel/card                        Criar
 *   GET  /v2/panel/card/{id}                   Obter por ID
 *   PUT  /v3/panel/card/{id}                   Atualizar
 *   GET  /v1/panel/card/{cardId}/note          Listar anotacoes
 *   POST /v1/panel/card/{cardId}/note          Adicionar anotacao
 *
 * CONTRATO DE ESCRITA — CONFIRMADO:
 *   PUT https://api.wts.chat/crm/v3/panel/card/{id}
 *   O corpo declara em `fields` quais campos mudam. Status aceita
 *   OPEN | WON | LOST | ARCHIVED, e o motivo de perda vai em `lostReasonId`.
 *
 * A trava FLW_CARD_WRITE_CONFIRMED permanece por um unico motivo: os 14
 * valores do enum `fields` estao ocultos na documentacao publica. A grafia
 * usada e inferida do texto da pagina. Confirme-a antes de escrever em
 * producao, ou ajuste FLW_CARD_FIELDS_CASE.
 *
 * REGRA DE NEGOCIO DA API (declarada no briefing):
 *   Cards WON ou LOST NAO podem ser movidos entre etapas. Para mover, e
 *   preciso primeiro reabrir com status OPEN. Isso e verificado em
 *   `assertCanChangeStep` antes de qualquer tentativa.
 */

function normalizeCardStatus(raw?: string): CardStatus {
  const upper = (raw ?? "").toUpperCase();
  if (upper.includes("WON") || upper.includes("GANH")) return "WON";
  if (upper.includes("LOST") || upper.includes("PERD")) return "LOST";
  if (upper.includes("ARCHIV") || upper.includes("ARQUIV")) return "ARCHIVED";
  return "OPEN";
}

/**
 * Fase da etapa, conforme o enum `stepPhase` do contrato.
 * Qualquer valor desconhecido cai em NONE (etapa intermediaria).
 */
function normalizeStepPhase(raw?: string): StepPhase {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "INITIAL") return "INITIAL";
  if (upper === "FINAL") return "FINAL";
  return "NONE";
}

/**
 * Mapeia o card usando os nomes CONFIRMADOS no contrato de
 * PUT https://api.wts.chat/crm/v3/panel/card/{id}.
 *
 * Tres campos exigiram correcao em relacao ao que este modulo assumia antes:
 *   contactId       -> contactIds, e uma LISTA (um card liga varios contatos)
 *   responsibleId   -> responsibleUserId
 *   amount          -> monetaryAmount
 *
 * Os nomes antigos seguem na lista de tentativas apenas para o caso de uma
 * instancia mais antiga da API; o nome oficial vem sempre primeiro.
 */
export function mapCard(raw: unknown, accountId: string, report: MappingReport): CrmCard | null {
  const id = readString(raw, ["id", "cardId"], "card.id", report);
  if (!id) return null;

  const contactIds = readIdList(raw, ["contactIds", "contacts"], "card.contactIds", report);
  const responsibleUser = readRecord(raw, ["responsibleUser"], "card.responsibleUser", report);
  const lostReason = readRecord(raw, ["lostReason"], "card.lostReason", report);

  return {
    id,
    accountId,
    panelId: readString(raw, ["panelId"], "card.panelId", report) ?? "",
    panelTitle: readString(raw, ["panelTitle"], "card.panelTitle", report),
    stepId: readString(raw, ["stepId"], "card.stepId", report) ?? "",
    stepName: readString(raw, ["stepTitle"], "card.stepTitle", report),
    stepPhase: normalizeStepPhase(readString(raw, ["stepPhase"], "card.stepPhase", report)),
    title: readString(raw, ["title"], "card.title", report) ?? "Card sem titulo",

    contactIds,
    contactId: contactIds[0],

    sessionId: readString(raw, ["sessionId"], "card.sessionId", report),
    responsibleId: readString(raw, ["responsibleUserId"], "card.responsibleUserId", report),
    responsibleName: responsibleUser
      ? readString(responsibleUser, ["name"], "card.responsibleUser.name")
      : undefined,

    amount: readNumber(raw, ["monetaryAmount"], "card.monetaryAmount", report),
    description: readString(raw, ["description"], "card.description", report),
    dueDate: readDate(raw, ["dueDate"], "card.dueDate", report),
    isOverdue: readBoolean(raw, ["isOverdue"], "card.isOverdue", report),

    status: normalizeCardStatus(readString(raw, ["status"], "card.status", report)),
    lostReasonId: lostReason ? readString(lostReason, ["id"], "card.lostReason.id") : undefined,
    lostReasonName: lostReason ? readString(lostReason, ["name"], "card.lostReason.name") : undefined,

    createdAt: readDate(raw, ["createdAt"], "card.createdAt", report) ?? new Date(0).toISOString(),
    updatedAt: readDate(raw, ["updatedAt"], "card.updatedAt", report) ?? new Date(0).toISOString(),
  };
}

/**
 * Campos que PUT /crm/v3/panel/card/{id} aceita em `fields`.
 *
 * A v3 nao infere o que mudou pelo corpo: e preciso DECLARAR quais campos
 * estao sendo atualizados. Isso e uma protecao — sem a declaracao, um campo
 * ausente poderia ser interpretado como "apagar".
 *
 * PENDENTE DE VALIDACAO: a documentacao lista 14 valores de enum sob
 * "Show 14 enum values", que nao estao visiveis na pagina publica. A grafia
 * PascalCase abaixo segue a convencao usada no proprio texto da documentacao
 * ("Este campo sera ignorado caso `TagIds` seja definido"). Se a API recusar,
 * ajuste FLW_CARD_FIELDS_CASE para "camel".
 */
const CAMPOS_DE_CARD = [
  "StepId",
  "Title",
  "Description",
  "Position",
  "DueDate",
  "ResponsibleUserId",
  "TagIds",
  "TagNames",
  "ContactIds",
  "SessionId",
  "MonetaryAmount",
  "Status",
  "LostReasonId",
  "CustomFields",
] as const;

export type CampoDeCard = (typeof CAMPOS_DE_CARD)[number];

/** Nome da propriedade correspondente no corpo da requisicao. */
const CAMPO_PARA_PROPRIEDADE: Record<CampoDeCard, string> = {
  StepId: "stepId",
  Title: "title",
  Description: "description",
  Position: "position",
  DueDate: "dueDate",
  ResponsibleUserId: "responsibleUserId",
  TagIds: "tagIds",
  TagNames: "tagNames",
  ContactIds: "contactIds",
  SessionId: "sessionId",
  MonetaryAmount: "monetaryAmount",
  Status: "status",
  LostReasonId: "lostReasonId",
  CustomFields: "customFields",
};

/**
 * Aplica a grafia esperada pela API ao nome do campo.
 * Enquanto os valores exatos do enum nao forem confirmados, a grafia e
 * configuravel para permitir correcao sem alterar codigo.
 */
function grafiaDoCampo(campo: CampoDeCard): string {
  return process.env.FLW_CARD_FIELDS_CASE === "camel"
    ? CAMPO_PARA_PROPRIEDADE[campo]
    : campo;
}

/** Erro de regra de negocio, distinto de erro de transporte. */
export class CardRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardRuleError";
  }
}

/**
 * Regra da API: cards WON ou LOST nao podem ser movidos entre etapas.
 * Lanca com uma mensagem acionavel em vez de deixar a API recusar.
 */
export function assertCanChangeStep(card: CrmCard): void {
  if (card.status === "WON" || card.status === "LOST") {
    throw new CardRuleError(
      `O card "${card.title}" esta com status ${card.status} e nao pode ser ` +
        `movido de etapa. Reabra-o com status OPEN antes de movimentar.`,
    );
  }
  if (card.status === "ARCHIVED") {
    throw new CardRuleError(
      `O card "${card.title}" esta arquivado. Desarquive antes de movimentar.`,
    );
  }
}

/** Escrita real so e liberada apos confirmacao explicita dos campos da v3. */
function cardWritesConfirmed(): boolean {
  return process.env.FLW_CARD_WRITE_CONFIRMED === "true";
}

const WRITE_BLOCKED_REASON =
  "Escrita de card ainda nao liberada. O contrato de PUT /crm/v3/panel/card/{id} " +
  "esta confirmado, mas os 14 valores do enum `fields` nao aparecem na " +
  "documentacao publica e a grafia usada e inferida. Confirme o enum e defina " +
  "FLW_CARD_WRITE_CONFIRMED=true.";

export interface CreateCardInput {
  accountId: string;
  panelId: string;
  stepId: string;
  title: string;
  contactId?: string;
  sessionId?: string;
  responsibleId?: string;
  amount?: number;
  description?: string;
  dueDate?: string;
  dryRun: boolean;
}

export interface UpdateCardInput {
  accountId: string;
  cardId: string;
  /** Card atual, necessario para validar a regra de movimentacao. */
  current: CrmCard;
  stepId?: string;
  responsibleId?: string;
  amount?: number;
  description?: string;
  dueDate?: string;
  status?: CardStatus;
  /** API: `lostReasonId`. */
  lostReasonId?: string;
  dryRun: boolean;
}

export const cardsAdapter = {
  /**
   * Lista os cards de UM painel.
   *
   * `panelId` e obrigatorio — nao por escolha nossa, mas porque a API exige.
   * Chamar sem ele devolve:
   *
   *   500 FORM_ERROR "The PanelId field is required."
   *
   * Isso foi descoberto pela sonda /api/health/probe contra a conta real.
   * Antes, a assinatura aceitava `panelId` opcional e a Central chamava sem
   * ele: o resultado era zero cards e um erro 500 a cada carregamento.
   * Para varrer varios paineis, use `listForPanels`.
   */
  async list(params: {
    accountId: string;
    panelId: string;
    maxPages?: number;
  }): Promise<AdapterResult<CrmCard[]>> {
    if (shouldUseMock()) {
      const data = MOCK_CARDS.filter(
        (c) => c.accountId === params.accountId && c.panelId === params.panelId,
      );
      return mockResult(data);
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(
      ENDPOINTS.CARDS.LIST,
      { query: { panelId: params.panelId } },
      {},
      params.maxPages ?? 10,
    );

    const cards = raw
      .map((item) => mapCard(item, params.accountId, report))
      .filter((c): c is CrmCard => c !== null);

    return liveResult(cards, report, "Card");
  },

  /**
   * Varre varios paineis e junta os cards.
   *
   * Falha PARCIAL nao derruba o resto: a conta pode ter painel arquivado, sem
   * permissao para o token ou com configuracao incompleta, e perder todos os
   * cards por causa de um deles seria desproporcional. Esses paineis saem em
   * `pendingValidation`, para que a interface diga o que ficou de fora em vez
   * de omitir em silencio.
   *
   * Falha TOTAL — nenhum painel respondeu — propaga o erro. "Zero cards"
   * quando na verdade a leitura inteira falhou seria a pior resposta
   * possivel: a Central concluiria que nao ha nenhuma oportunidade no CRM e
   * sugeriria criar cards que ja existem.
   */
  async listForPanels(params: {
    accountId: string;
    panelIds: string[];
    maxPages?: number;
  }): Promise<AdapterResult<CrmCard[]>> {
    if (params.panelIds.length === 0) {
      return { data: [], source: shouldUseMock() ? "mock" : "live", pendingValidation: [] };
    }

    const resultados = await Promise.allSettled(
      params.panelIds.map((panelId) =>
        cardsAdapter.list({
          accountId: params.accountId,
          panelId,
          ...(params.maxPages === undefined ? {} : { maxPages: params.maxPages }),
        }),
      ),
    );

    const cards: CrmCard[] = [];
    const pendingValidation: string[] = [];
    let source: AdapterResult<CrmCard[]>["source"] = "live";
    let respondeuAlgum = false;

    resultados.forEach((resultado, indice) => {
      if (resultado.status === "fulfilled") {
        respondeuAlgum = true;
        cards.push(...resultado.value.data);
        pendingValidation.push(...resultado.value.pendingValidation);
        source = resultado.value.source;
        return;
      }

      const painel = params.panelIds[indice] ?? "(desconhecido)";
      const motivo =
        resultado.reason instanceof Error ? resultado.reason.message : String(resultado.reason);

      pendingValidation.push(
        `Nao foi possivel ler os cards do painel ${painel}: ${motivo}`,
      );
    });

    // Nenhum painel respondeu: isso nao e "a conta nao tem cards", e sim
    // "nao conseguimos ler o CRM". Propaga o primeiro erro real.
    if (!respondeuAlgum) {
      const primeiraFalha = resultados.find((r) => r.status === "rejected");
      throw (primeiraFalha as PromiseRejectedResult).reason;
    }

    return { data: cards, source, pendingValidation };
  },

  /**
   * Procura um card aberto para o contato, para EVITAR DUPLICIDADE antes de
   * sugerir a criacao de um novo.
   *
   * Recebe os paineis onde procurar porque a API exige o painel na listagem.
   */
  async findOpenCardForContact(params: {
    accountId: string;
    contactId: string;
    panelIds: string[];
  }): Promise<AdapterResult<CrmCard | null>> {
    if (shouldUseMock()) {
      const found = findCardByContact(params.contactId);
      return mockResult(found && found.status === "OPEN" ? found : null);
    }

    const all = await cardsAdapter.listForPanels({
      accountId: params.accountId,
      panelIds: params.panelIds,
    });
    const match = all.data.find(
      (c) => c.contactId === params.contactId && c.status === "OPEN",
    );
    return { ...all, data: match ?? null };
  },

  async create(input: CreateCardInput): Promise<AdapterResult<CrmCard | null>> {
    const contract = ENDPOINTS.CARDS.CREATE;

    if (input.dryRun || shouldUseMock()) {
      const preview: CrmCard = {
        id: "card_simulado",
        accountId: input.accountId,
        panelId: input.panelId,
        stepId: input.stepId,
        title: input.title,
        contactIds: input.contactId ? [input.contactId] : [],
        contactId: input.contactId,
        sessionId: input.sessionId,
        responsibleId: input.responsibleId,
        amount: input.amount,
        description: input.description,
        dueDate: input.dueDate,
        status: "OPEN",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return mockResult(preview, ["Simulacao: nenhum card foi criado na plataforma."]);
    }

    if (!cardWritesConfirmed()) {
      return { data: null, source: "live", pendingValidation: [WRITE_BLOCKED_REASON, ...contract.pending] };
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(contract, {
      body: {
        panelId: input.panelId,
        stepId: input.stepId,
        title: input.title,
        // Nomes oficiais: lista de contatos, responsibleUserId, monetaryAmount.
        contactIds: input.contactId ? [input.contactId] : undefined,
        sessionId: input.sessionId,
        responsibleUserId: input.responsibleId,
        monetaryAmount: input.amount,
        description: input.description,
        dueDate: input.dueDate,
      },
      idempotencyKey: buildIdempotencyKey({
        accountId: input.accountId,
        actionType: "CRIAR_CARD",
        targetId: input.contactId ?? input.sessionId ?? input.title,
      }),
    });

    return liveResult(mapCard(response.data, input.accountId, report), report, "Card");
  },

  async update(input: UpdateCardInput): Promise<AdapterResult<CrmCard | null>> {
    const contract = ENDPOINTS.CARDS.UPDATE;

    // Regra da API verificada ANTES de qualquer chamada.
    if (input.stepId && input.stepId !== input.current.stepId) {
      assertCanChangeStep(input.current);
    }

    if (input.dryRun || shouldUseMock()) {
      const preview: CrmCard = {
        ...input.current,
        stepId: input.stepId ?? input.current.stepId,
        responsibleId: input.responsibleId ?? input.current.responsibleId,
        amount: input.amount ?? input.current.amount,
        description: input.description ?? input.current.description,
        dueDate: input.dueDate ?? input.current.dueDate,
        status: input.status ?? input.current.status,
        updatedAt: new Date().toISOString(),
      };
      return mockResult(preview, ["Simulacao: nenhum card foi alterado na plataforma."]);
    }

    if (!cardWritesConfirmed()) {
      return { data: null, source: "live", pendingValidation: [WRITE_BLOCKED_REASON, ...contract.pending] };
    }

    /*
     * A v3 exige declarar quais campos estao sendo atualizados. Montamos a
     * lista a partir do que o chamador realmente informou: um campo que ele
     * nao pediu para mudar nunca entra em `fields`, e portanto nunca e tocado.
     */
    const alteracoes: { campo: CampoDeCard; valor: unknown }[] = [];

    if (input.stepId !== undefined) alteracoes.push({ campo: "StepId", valor: input.stepId });
    if (input.responsibleId !== undefined) alteracoes.push({ campo: "ResponsibleUserId", valor: input.responsibleId });
    if (input.amount !== undefined) alteracoes.push({ campo: "MonetaryAmount", valor: input.amount });
    if (input.description !== undefined) alteracoes.push({ campo: "Description", valor: input.description });
    if (input.dueDate !== undefined) alteracoes.push({ campo: "DueDate", valor: input.dueDate });
    if (input.status !== undefined) alteracoes.push({ campo: "Status", valor: input.status });
    if (input.lostReasonId !== undefined) alteracoes.push({ campo: "LostReasonId", valor: input.lostReasonId });

    // Nada a fazer: devolvemos o card como esta, sem gastar uma chamada.
    if (alteracoes.length === 0) {
      return { data: input.current, source: "live", pendingValidation: [] };
    }

    const corpo: Record<string, unknown> = {
      fields: alteracoes.map((a) => grafiaDoCampo(a.campo)),
    };
    for (const { campo, valor } of alteracoes) {
      corpo[CAMPO_PARA_PROPRIEDADE[campo]] = valor;
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(contract, {
      pathParams: { id: input.cardId },
      body: corpo,
      idempotencyKey: buildIdempotencyKey({
        accountId: input.accountId,
        actionType: "ATUALIZAR_CARD",
        targetId: input.cardId,
        discriminator: JSON.stringify(corpo),
      }),
    });

    return liveResult(mapCard(response.data, input.accountId, report), report, "Card");
  },

  async addNote(params: {
    accountId: string;
    cardId: string;
    text: string;
    dryRun: boolean;
  }): Promise<AdapterResult<CardNote | null>> {
    const contract = ENDPOINTS.CARD_NOTES.CREATE;

    if (params.dryRun || shouldUseMock()) {
      return mockResult(
        {
          id: "note_simulada",
          cardId: params.cardId,
          text: params.text,
          authorId: "flowi-ia",
          createdAt: new Date().toISOString(),
        },
        ["Simulacao: nenhuma anotacao foi gravada na plataforma."],
      );
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(contract, {
      pathParams: { cardId: params.cardId },
      body: { text: params.text },
      idempotencyKey: buildIdempotencyKey({
        accountId: params.accountId,
        actionType: "CRIAR_NOTA",
        targetId: params.cardId,
        discriminator: params.text.slice(0, 64),
      }),
    });

    const id = readString(response.data, ["id", "noteId"], "cardNote.id", report);
    return liveResult(
      id
        ? {
            id,
            cardId: params.cardId,
            text: params.text,
            authorId: "flowi-ia",
            createdAt: readDate(response.data, ["createdAt"], "cardNote.createdAt", report) ?? new Date().toISOString(),
          }
        : null,
      report,
      "Anotacao",
    );
  },
};
