import "server-only";
import type { ContactSnapshot } from "@/domain/types";
import { MOCK_CONTACTS, findContact } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import { MappingReport, readDate, readIdList, readRecord, readString } from "../mappers/tolerant";
import {
  buildIdempotencyKey,
  liveResult,
  mockResult,
  shouldUseMock,
  type AdapterResult,
} from "./base";

/**
 * ContactsAdapter — contatos e suas etiquetas.
 *
 * Endpoints CONFIRMADOS:
 *   GET  /v1/contact                       Listagem paginada
 *   GET  /v1/contact/{id}                  Obter por ID
 *   POST /v1/contact/filter                Filtragem paginada
 *   PUT  /v2/contact/{id}                  Atualizar
 *   POST /v1/contact/{id}/tags             Atualizar etiquetas
 *
 * SEMANTICA DAS ETIQUETAS — CONFIRMADA NA DOCUMENTACAO:
 *   POST https://api.wts.chat/core/v1/contact/{id}/tags aceita um campo
 *   `operation` que decide o que acontece:
 *
 *     InsertIfNotExists  insere as etiquetas que ainda nao estao no contato
 *     DeleteIfExists     remove as etiquetas informadas
 *     ReplaceAll         APAGA TODAS as etiquetas e grava apenas as enviadas
 *
 *   Este modulo usa SOMENTE InsertIfNotExists. ReplaceAll apagaria as
 *   etiquetas que a equipe aplicou manualmente, e nao ha caso de uso da IA
 *   que justifique isso. A constante abaixo existe para tornar essa escolha
 *   explicita e impossivel de trocar por engano.
 */

/**
 * Operacoes aceitas pelo endpoint de etiquetas.
 *
 * `ReplaceAll` esta declarada apenas para documentar que existe. O modulo
 * nunca a envia: apagar as etiquetas manuais da equipe seria destrutivo e
 * irreversivel.
 */
export const TAG_OPERATIONS = {
  INSERIR_SE_AUSENTE: "InsertIfNotExists",
  REMOVER_SE_PRESENTE: "DeleteIfExists",
  /** NAO USAR: remove todas as etiquetas do contato antes de gravar. */
  SUBSTITUIR_TUDO: "ReplaceAll",
} as const;

/**
 * Operacao que este modulo envia ao aplicar etiquetas.
 *
 * Exportada para que um teste automatizado impeca a troca por `ReplaceAll`,
 * que apagaria as etiquetas aplicadas manualmente pela equipe.
 */
export const OPERACAO_DE_ETIQUETAS = TAG_OPERATIONS.INSERIR_SE_AUSENTE;

export function mapContact(
  raw: unknown,
  accountId: string,
  report: MappingReport,
): ContactSnapshot | null {
  const id = readString(raw, ["id", "contactId", "uuid"], "contact.id", report);
  if (!id) return null;

  return {
    id,
    accountId,
    name:
      readString(raw, ["name", "fullName", "displayName", "firstName"], "contact.name", report) ??
      "Contato sem nome",
    phone: readString(raw, ["phoneNumber", "phone", "number", "whatsapp"], "contact.phone", report),
    email: readString(raw, ["email", "mail", "emailAddress"], "contact.email", report),
    /**
     * O contrato de contato NAO tem campo de empresa: `companyId` na resposta
     * e o identificador da CONTA na KlipFlowi, nao o empregador do contato.
     * Quando a conta guarda a empresa, ela vive em `customFields`, cujo nome
     * varia por cliente — por isso e configuravel e fica vazio por padrao.
     */
    company: readCompanyFromCustomFields(raw, report),
    tagIds: readIdList(raw, ["tags", "tagIds", "labels"], "contact.tagIds", report),
    createdAt: readDate(raw, ["createdAt", "created_at"], "contact.createdAt", report) ?? new Date(0).toISOString(),
    updatedAt: readDate(raw, ["updatedAt", "updated_at"], "contact.updatedAt", report) ?? new Date(0).toISOString(),
  };
}


/**
 * Le a empresa do contato a partir de um campo personalizado.
 *
 * O nome do campo varia por conta, entao e informado em FLW_CONTACT_COMPANY_FIELD.
 * Sem essa variavel, o modulo simplesmente nao exibe empresa — melhor um campo
 * vazio do que um valor tirado do lugar errado.
 */
function readCompanyFromCustomFields(
  raw: unknown,
  report: MappingReport,
): string | undefined {
  const fieldName = process.env.FLW_CONTACT_COMPANY_FIELD;
  if (!fieldName) return undefined;

  const custom = readRecord(raw, ["customFields"], "contact.customFields", report);
  if (!custom) return undefined;

  return readString(custom, [fieldName], "contact.company");
}

export const contactsAdapter = {
  async getById(params: {
    accountId: string;
    contactId: string;
  }): Promise<AdapterResult<ContactSnapshot | null>> {
    if (shouldUseMock()) {
      const found = findContact(params.contactId);
      return mockResult(found && found.accountId === params.accountId ? found : null);
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(ENDPOINTS.CONTACTS.GET_BY_ID, {
      pathParams: { id: params.contactId },
    });

    return liveResult(mapContact(response.data, params.accountId, report), report, "Contato");
  },

  async list(params: {
    accountId: string;
    maxPages?: number;
  }): Promise<AdapterResult<ContactSnapshot[]>> {
    if (shouldUseMock()) {
      return mockResult(MOCK_CONTACTS.filter((c) => c.accountId === params.accountId));
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(
      ENDPOINTS.CONTACTS.LIST,
      {},
      {},
      params.maxPages ?? 10,
    );

    const contacts = raw
      .map((item) => mapContact(item, params.accountId, report))
      .filter((c): c is ContactSnapshot => c !== null);

    return liveResult(contacts, report, "Contato");
  },

  /**
   * Aplica etiquetas a um contato, de forma puramente ADITIVA.
   *
   * Envia `operation: "InsertIfNotExists"`, que insere apenas as etiquetas
   * ainda ausentes. Etiquetas aplicadas manualmente pela equipe permanecem
   * intactas, e reenviar a mesma lista nao produz efeito — a operacao e
   * idempotente do lado da API.
   *
   * Aceita nomes ou identificadores. Preferimos IDs quando o chamador ja os
   * resolveu contra a conta; nomes servem para etiquetas recem-aprovadas.
   */
  async applyTags(params: {
    accountId: string;
    /** ID do contato. O endpoint tambem aceita o numero de telefone. */
    contactId: string;
    tagIds?: string[];
    tagNames?: string[];
    dryRun: boolean;
  }): Promise<AdapterResult<{ applied: boolean; reason?: string; tagIds?: string[] }>> {
    const contract = ENDPOINTS.CONTACTS.SET_TAGS;
    const temIds = (params.tagIds?.length ?? 0) > 0;
    const temNomes = (params.tagNames?.length ?? 0) > 0;

    if (!temIds && !temNomes) {
      return mockResult({
        applied: false,
        reason: "Nenhuma etiqueta informada.",
      });
    }

    if (params.dryRun || shouldUseMock()) {
      return mockResult({
        applied: false,
        reason:
          "Simulacao: nenhuma alteracao enviada a API. Em modo real seria enviada " +
          `a operacao ${OPERACAO_DE_ETIQUETAS}, que apenas acrescenta.`,
      });
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(contract, {
      pathParams: { id: params.contactId },
      body: {
        tagIds: temIds ? params.tagIds : undefined,
        tagNames: temNomes ? params.tagNames : undefined,
        // Nunca ReplaceAll: apagaria as etiquetas manuais da equipe.
        operation: OPERACAO_DE_ETIQUETAS,
      },
      idempotencyKey: buildIdempotencyKey({
        accountId: params.accountId,
        actionType: "APLICAR_ETIQUETAS",
        targetId: params.contactId,
        discriminator: [...(params.tagIds ?? []), ...(params.tagNames ?? [])].sort().join(","),
      }),
    });

    // A resposta devolve o contato inteiro, entao confirmamos o resultado
    // em vez de presumir que deu certo.
    const aplicadas = readIdList(response.data, ["tagIds"], "contact.tagIds", report);

    return liveResult({ applied: true, tagIds: aplicadas }, report, "Contato");
  },
};
