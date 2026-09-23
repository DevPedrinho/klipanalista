import type { ClienteKlipflowi } from "./client";

/** Endpoints usados pelo Módulo 01. Contratos em docs/api-klipflowi.md. */
export function klipflowiApi(cliente: ClienteKlipflowi) {
  return {
    listarAtendentes: () => cliente.todasAsPaginas<{ id?: unknown }>("/core/v1/agent"),

    paginaDeConversas: (numero: number) => cliente.pagina<unknown>("/chat/v2/session", numero),

    buscarConversa: (id: string) => cliente.request<unknown>(`/chat/v2/session/${encodeURIComponent(id)}`),

    listarMensagens: (sessionId: string) =>
      cliente.todasAsPaginas<{ id?: unknown }>(`/chat/v1/session/${encodeURIComponent(sessionId)}/message`),

    buscarContato: (id: string) => cliente.request<unknown>(`/core/v1/contact/${encodeURIComponent(id)}`),

    listarPaineis: () => cliente.todasAsPaginas<{ id?: unknown }>("/crm/v2/panel"),

    /** `PanelId` é obrigatório (sem ele a API devolve 500). */
    listarCardsDoPainel: (panelId: string, maxPaginas = 10) =>
      cliente.todasAsPaginas<{ id?: unknown }>("/crm/v2/panel/card", { PanelId: panelId }, maxPaginas),

    /** Corpo ainda não validado contra a API real (ver docs). */
    criarCard: (corpo: NovoCard) =>
      cliente.request<unknown>("/crm/v2/panel/card", { method: "POST", body: corpo }),

    listarAnotacoes: (cardId: string) =>
      cliente.todasAsPaginas<{ id?: unknown }>(`/crm/v1/panel/card/${encodeURIComponent(cardId)}/note`),

    /** Corpo ainda não validado contra a API real (ver docs). */
    criarAnotacao: (cardId: string, texto: string) =>
      cliente.request<unknown>(`/crm/v1/panel/card/${encodeURIComponent(cardId)}/note`, {
        method: "POST",
        body: { text: texto },
      }),
  };
}

export interface NovoCard {
  panelId: string;
  stepId: string;
  title: string;
  contactIds: string[];
  responsibleUserId?: string;
  monetaryAmount?: number;
}

export type KlipflowiApi = ReturnType<typeof klipflowiApi>;
