import "server-only";
import type { Tag } from "@/domain/types";
import { MOCK_TAGS } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import { MappingReport, readString } from "../mappers/tolerant";
import {
  buildIdempotencyKey,
  liveResult,
  mockResult,
  shouldUseMock,
  type AdapterResult,
} from "./base";

/**
 * TagsAdapter — etiquetas da conta.
 *
 * Endpoints CONFIRMADOS:
 *   GET    /v1/tag          Listagem
 *   POST   /v1/tag          Criar (sem cor -> GRAY_600)
 *   GET    /v1/tag/color    Cores disponiveis
 *   PUT    /v1/tag/{id}     Atualizar
 *   DELETE /v1/tag/{id}     Excluir (exige removeFromContacts se vinculada)
 *
 * REGRA DE PRODUTO: a IA nunca cria etiqueta livremente. `create` existe,
 * mas so e chamado pelo fluxo de aprovacao administrativa
 * (ver tag-taxonomy.service.ts).
 *
 * DELETE nao e exposto: excluir etiqueta e irreversivel e removeria a
 * etiqueta de todos os contatos vinculados.
 */

export function mapTag(raw: unknown, accountId: string, report: MappingReport): Tag | null {
  const id = readString(raw, ["id", "tagId", "uuid"], "tag.id", report);
  if (!id) return null;

  return {
    id,
    accountId,
    name: readString(raw, ["name", "title", "label"], "tag.name", report) ?? "Etiqueta sem nome",
    color: readString(raw, ["color", "colorName", "hexColor"], "tag.color", report),
  };
}

export const tagsAdapter = {
  async list(params: { accountId: string }): Promise<AdapterResult<Tag[]>> {
    if (shouldUseMock()) {
      return mockResult(MOCK_TAGS.filter((t) => t.accountId === params.accountId));
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(ENDPOINTS.TAGS.LIST, {}, {}, 5);

    const tags = raw
      .map((item) => mapTag(item, params.accountId, report))
      .filter((t): t is Tag => t !== null);

    return liveResult(tags, report, "Etiqueta");
  },

  /** Cores aceitas na criacao. O valor de `color` deve vir desta lista. */
  async listColors(): Promise<AdapterResult<string[]>> {
    if (shouldUseMock()) {
      return mockResult([
        "GRAY_600", "BLUE_600", "PURPLE_600", "RED_600",
        "GREEN_600", "ORANGE_600", "YELLOW_600", "PINK_600",
      ], [
        "Lista de cores simulada. A lista real vem de GET /v1/tag/color.",
      ]);
    }

    const response = await apiRequest<unknown>(ENDPOINTS.TAGS.LIST_COLORS, {});
    const payload = response.data;

    const colors: string[] = [];
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (typeof item === "string") colors.push(item);
        else {
          const value = readString(item, ["color", "name", "value"], "tagColor.value");
          if (value) colors.push(value);
        }
      }
    }
    return liveResult(colors, undefined, "Cor de etiqueta");
  },

  /**
   * Cria uma etiqueta. Chamado SOMENTE apos aprovacao administrativa
   * registrada na auditoria.
   */
  async create(params: {
    accountId: string;
    name: string;
    color?: string;
    approvedByUserId: string;
    dryRun: boolean;
  }): Promise<AdapterResult<Tag | null>> {
    if (params.dryRun || shouldUseMock()) {
      return mockResult(
        {
          id: `tag_simulada_${params.name.toLowerCase().replace(/\W+/g, "_")}`,
          accountId: params.accountId,
          name: params.name,
          color: params.color ?? "GRAY_600",
        },
        ["Simulacao: a etiqueta nao foi criada na plataforma."],
      );
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(ENDPOINTS.TAGS.CREATE, {
      body: { name: params.name, color: params.color },
      idempotencyKey: buildIdempotencyKey({
        accountId: params.accountId,
        actionType: "CRIAR_ETIQUETA",
        targetId: params.name,
      }),
    });

    return liveResult(mapTag(response.data, params.accountId, report), report, "Etiqueta");
  },
};
