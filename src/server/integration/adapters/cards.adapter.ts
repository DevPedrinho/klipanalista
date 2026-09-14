import "server-only";
import type { CardStatus } from "@/domain/enums";
import type { CardNote, CrmCard } from "@/domain/types";
import { MOCK_CARDS, findCardByContact } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import { MappingReport, readDate, readNumber, readString } from "../mappers/tolerant";
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
 * PENDENTE DE VALIDACAO (critico): os NOMES DOS CAMPOS do corpo da v3 e
 * como o status WON/LOST e o motivo de perda sao enviados. Por isso as
 * escritas exigem FLW_CARD_WRITE_CONFIRMED=true, alem do modo de automacao.
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

export function mapCard(raw: unknown, accountId: string, report: MappingReport): CrmCard | null {
  const id = readString(raw, ["id", "cardId", "uuid"], "card.id", report);
  if (!id) return null;

  return {
    id,
    accountId,
    panelId: readString(raw, ["panelId", "panel_id", "boardId"], "card.panelId", report) ?? "",
    stepId: readString(raw, ["stepId", "stageId", "columnId", "step_id"], "card.stepId", report) ?? "",
    title: readString(raw, ["title", "name", "subject"], "card.title", report) ?? "Card sem titulo",
    contactId: readString(raw, ["contactId", "contact_id"], "card.contactId", report),
    sessionId: readString(raw, ["sessionId", "session_id", "conversationId"], "card.sessionId", report),
    responsibleId: readString(
      raw,
      ["responsibleId", "userId", "assigneeId", "ownerId"],
      "card.responsibleId",
      report,
    ),
    amount: readNumber(raw, ["amount", "value", "monetaryValue", "price"], "card.amount", report),
    description: readString(raw, ["description", "notes", "details"], "card.description", report),
    dueDate: readDate(raw, ["dueDate", "deadline", "expiresAt"], "card.dueDate", report),
    status: normalizeCardStatus(readString(raw, ["status", "state", "situation"], "card.status", report)),
    createdAt: readDate(raw, ["createdAt", "created_at"], "card.createdAt", report) ?? new Date(0).toISOString(),
    updatedAt: readDate(raw, ["updatedAt", "updated_at"], "card.updatedAt", report) ?? new Date(0).toISOString(),
  };
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
  "Escrita de card bloqueada: os nomes dos campos do corpo de PUT /v3/panel/card/{id} " +
  "ainda nao foram confirmados na documentacao. Apos confirmar, defina " +
  "FLW_CARD_WRITE_CONFIRMED=true e ajuste o mapper de escrita.";

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
  lossReasonId?: string;
  dryRun: boolean;
}

export const cardsAdapter = {
  async list(params: {
    accountId: string;
    panelId?: string;
    maxPages?: number;
  }): Promise<AdapterResult<CrmCard[]>> {
    if (shouldUseMock()) {
      const data = MOCK_CARDS.filter(
        (c) => c.accountId === params.accountId && (!params.panelId || c.panelId === params.panelId),
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
   * Procura um card aberto para o contato, para EVITAR DUPLICIDADE antes de
   * sugerir a criacao de um novo.
   */
  async findOpenCardForContact(params: {
    accountId: string;
    contactId: string;
  }): Promise<AdapterResult<CrmCard | null>> {
    if (shouldUseMock()) {
      const found = findCardByContact(params.contactId);
      return mockResult(found && found.status === "OPEN" ? found : null);
    }

    const all = await cardsAdapter.list({ accountId: params.accountId });
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
        contactId: input.contactId,
        sessionId: input.sessionId,
        responsibleId: input.responsibleId,
        amount: input.amount,
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

    const report = new MappingReport();
    const response = await apiRequest<unknown>(contract, {
      pathParams: { id: input.cardId },
      body: {
        stepId: input.stepId,
        responsibleId: input.responsibleId,
        amount: input.amount,
        description: input.description,
        dueDate: input.dueDate,
        status: input.status,
        lossReasonId: input.lossReasonId,
      },
      idempotencyKey: buildIdempotencyKey({
        accountId: input.accountId,
        actionType: "ATUALIZAR_CARD",
        targetId: input.cardId,
        discriminator: JSON.stringify({
          s: input.stepId, r: input.responsibleId, a: input.amount, st: input.status,
        }),
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
