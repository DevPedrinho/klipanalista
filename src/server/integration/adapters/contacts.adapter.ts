import "server-only";
import type { ContactSnapshot } from "@/domain/types";
import { MOCK_CONTACTS, findContact } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import { MappingReport, readDate, readIdList, readString } from "../mappers/tolerant";
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
 * PENDENTE DE VALIDACAO (critico para escrita):
 *   A semantica de POST /v1/contact/{id}/tags — se o corpo SUBSTITUI a lista
 *   inteira de etiquetas ou apenas ADICIONA. Enquanto isso nao for
 *   confirmado, `applyTags` recusa-se a executar: substituir a lista por
 *   engano apagaria etiquetas que a equipe aplicou manualmente.
 */

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
    company: readString(raw, ["company", "companyName", "organization"], "contact.company", report),
    tagIds: readIdList(raw, ["tags", "tagIds", "labels"], "contact.tagIds", report),
    createdAt: readDate(raw, ["createdAt", "created_at"], "contact.createdAt", report) ?? new Date(0).toISOString(),
    updatedAt: readDate(raw, ["updatedAt", "updated_at"], "contact.updatedAt", report) ?? new Date(0).toISOString(),
  };
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
   * Aplica etiquetas a um contato.
   *
   * BLOQUEADO ATE VALIDACAO: ver nota no topo do arquivo. A assinatura ja
   * esta pronta; apenas a execucao real esta impedida, de proposito.
   */
  async applyTags(params: {
    accountId: string;
    contactId: string;
    /** Lista COMPLETA desejada (atuais + novas), para o caso de substituicao. */
    tagIds: string[];
    dryRun: boolean;
  }): Promise<AdapterResult<{ applied: boolean; reason?: string }>> {
    const contract = ENDPOINTS.CONTACTS.SET_TAGS;

    if (params.dryRun || shouldUseMock()) {
      return mockResult(
        { applied: false, reason: "Simulacao: nenhuma alteracao enviada a API." },
        contract.pending,
      );
    }

    const semanticsConfirmed = process.env.FLW_CONTACT_TAGS_SEMANTICS === "replace" ||
      process.env.FLW_CONTACT_TAGS_SEMANTICS === "append";

    if (!semanticsConfirmed) {
      return {
        data: {
          applied: false,
          reason:
            "Escrita bloqueada: a semantica de POST /v1/contact/{id}/tags ainda nao " +
            "foi confirmada (substitui ou adiciona?). Defina FLW_CONTACT_TAGS_SEMANTICS " +
            "como 'replace' ou 'append' apos confirmar na documentacao.",
        },
        source: "live",
        pendingValidation: contract.pending,
      };
    }

    await apiRequest(contract, {
      pathParams: { id: params.contactId },
      body: { tags: params.tagIds },
      idempotencyKey: buildIdempotencyKey({
        accountId: params.accountId,
        actionType: "APLICAR_ETIQUETAS",
        targetId: params.contactId,
        discriminator: [...params.tagIds].sort().join(","),
      }),
    });

    return liveResult({ applied: true }, undefined, "Contato");
  },
};
