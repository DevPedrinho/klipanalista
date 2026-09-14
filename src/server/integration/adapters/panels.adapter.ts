import "server-only";
import type { PanelType } from "@/domain/enums";
import type { LossReason, Panel, PanelStep } from "@/domain/types";
import { MOCK_LOSS_REASONS, MOCK_PANELS, findPanel } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequest, apiRequestAllPages } from "../http/client";
import { MappingReport, readArray, readNumber, readString } from "../mappers/tolerant";
import { liveResult, mockResult, shouldUseMock, type AdapterResult } from "./base";

/**
 * PanelsAdapter — paineis do CRM e suas etapas.
 *
 * Endpoints CONFIRMADOS:
 *   GET /v2/panel                    Listar paineis
 *   GET /v1/panel/{id}               Obter por ID (traz as etapas)
 *   GET /v1/panel/{id}/lost-reason   Motivos de perda
 *   GET /v1/panel/{id}/custom-fields Campos personalizados
 *
 * PENDENTE DE VALIDACAO: os literais do tipo de painel. O briefing cita
 * SALES e MANAGEMENT; a normalizacao abaixo aceita variacoes e cai em
 * SALES como padrao, registrando a incerteza.
 */

function normalizePanelType(raw?: string): PanelType {
  const upper = (raw ?? "").toUpperCase();
  if (upper.includes("MANAG") || upper.includes("GEST")) return "MANAGEMENT";
  return "SALES";
}

function mapStep(raw: unknown, index: number, report: MappingReport): PanelStep | null {
  const id = readString(raw, ["id", "stepId", "uuid"], "panelStep.id", report);
  if (!id) return null;

  return {
    id,
    name: readString(raw, ["name", "title", "label"], "panelStep.name", report) ?? `Etapa ${index + 1}`,
    order: readNumber(raw, ["order", "position", "index", "sequence"], "panelStep.order", report) ?? index,
  };
}

export function mapPanel(raw: unknown, accountId: string, report: MappingReport): Panel | null {
  const id = readString(raw, ["id", "panelId", "uuid"], "panel.id", report);
  if (!id) return null;

  const stepsRaw = readArray(raw, ["steps", "stages", "columns", "phases"], "panel.steps", report);

  return {
    id,
    accountId,
    name: readString(raw, ["name", "title"], "panel.name", report) ?? "Painel sem nome",
    type: normalizePanelType(readString(raw, ["type", "panelType", "kind"], "panel.type", report)),
    steps: stepsRaw
      .map((item, index) => mapStep(item, index, report))
      .filter((s): s is PanelStep => s !== null)
      .sort((a, b) => a.order - b.order),
  };
}

export const panelsAdapter = {
  async list(params: { accountId: string }): Promise<AdapterResult<Panel[]>> {
    if (shouldUseMock()) {
      return mockResult(MOCK_PANELS.filter((p) => p.accountId === params.accountId));
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(ENDPOINTS.PANELS.LIST, {}, {}, 5);

    // A listagem pode nao trazer as etapas; buscamos o detalhe de cada painel.
    const summaries = raw
      .map((item) => mapPanel(item, params.accountId, report))
      .filter((p): p is Panel => p !== null);

    const detailed = await Promise.all(
      summaries.map(async (panel) => {
        if (panel.steps.length > 0) return panel;
        const detail = await apiRequest<unknown>(ENDPOINTS.PANELS.GET_BY_ID, {
          pathParams: { id: panel.id },
        });
        return mapPanel(detail.data, params.accountId, report) ?? panel;
      }),
    );

    return liveResult(detailed, report, "Painel");
  },

  async getById(params: {
    accountId: string;
    panelId: string;
  }): Promise<AdapterResult<Panel | null>> {
    if (shouldUseMock()) {
      const found = findPanel(params.panelId);
      return mockResult(found && found.accountId === params.accountId ? found : null);
    }

    const report = new MappingReport();
    const response = await apiRequest<unknown>(ENDPOINTS.PANELS.GET_BY_ID, {
      pathParams: { id: params.panelId },
    });

    return liveResult(mapPanel(response.data, params.accountId, report), report, "Painel");
  },

  /** Paineis de vendas. Usados como destino padrao para novos cards. */
  async listSalesPanels(params: { accountId: string }): Promise<AdapterResult<Panel[]>> {
    const result = await panelsAdapter.list(params);
    return { ...result, data: result.data.filter((p) => p.type === "SALES") };
  },

  async listLossReasons(params: {
    accountId: string;
    panelId: string;
  }): Promise<AdapterResult<LossReason[]>> {
    if (shouldUseMock()) return mockResult(MOCK_LOSS_REASONS);

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(
      ENDPOINTS.PANELS.LOST_REASONS,
      { pathParams: { id: params.panelId } },
      {},
      3,
    );

    const reasons = raw
      .map((item) => {
        const id = readString(item, ["id", "reasonId"], "lossReason.id", report);
        if (!id) return null;
        return {
          id,
          name: readString(item, ["name", "title", "description"], "lossReason.name", report) ?? id,
        } satisfies LossReason;
      })
      .filter((r): r is LossReason => r !== null);

    return liveResult(reasons, report, "Motivo de perda");
  },
};
