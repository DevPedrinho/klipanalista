"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionType } from "@/domain/enums";
import type {
  AgentQualityReport,
  ApiErrorBody,
  AuditLogEntry,
  ChatMessage,
  FunnelSummary,
  IntegrationSettings,
  IntelligenceKpis,
  Opportunity,
  Recommendation,
} from "@/domain/types";
import { Button, Notice } from "@/components/ui/primitives";
import { ActionModal, type ActionPreview, type PendingAction } from "./ActionModal";
import { ChatPanel } from "./ChatPanel";
import { FiltersBar, type FilterState, type UserOption } from "./FiltersBar";
import { KpiGrid } from "./KpiGrid";
import { OpportunityCard } from "./OpportunityCard";
import { AuditTab, FunnelTab, QualityTab, RecommendationsTab } from "./TabPanels";
import {
  ErrorState,
  LoadingSkeleton,
  NoIntegrationBanner,
  NoOpportunities,
  PendingValidationBanner,
} from "./StateViews";
import { apiGet, apiSend, toErrorBody } from "@/lib/api-client";
import { cx } from "@/lib/format";

/* ==========================================================================
   Tipos das respostas das rotas internas
   ========================================================================== */
interface OverviewResponse {
  kpis: IntelligenceKpis;
  opportunities: Opportunity[];
  funnels: FunnelSummary[];
  qualityReports: AgentQualityReport[];
  recommendations: Recommendation[];
  settings: IntegrationSettings;
  lastAnalysisAt: string;
  dataMode: "mock" | "live";
  pendingValidation: string[];
  context: { role: string; scope: string };
  integration: { ready: boolean; missing: string[] };
  availableUsers: UserOption[];
}

interface ActionResponse {
  status: string;
  requiresConfirmation?: boolean;
  reason?: string;
  preview: ActionPreview;
  auditId?: string;
  notice?: string;
}

interface AuditResponse {
  entries: AuditLogEntry[];
  total: number;
  acceptanceRate: number;
  scope: string;
}

interface ChatResponse {
  message: ChatMessage;
  suggestions: readonly string[];
}

const TABS = [
  { key: "oportunidades", label: "Oportunidades" },
  { key: "funil", label: "Funil e CRM" },
  { key: "qualidade", label: "Qualidade" },
  { key: "recomendacoes", label: "Recomendações" },
  { key: "chat", label: "Chat com a Flowi IA" },
  { key: "historico", label: "Histórico de ações" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const ACTION_LABELS: Partial<Record<ActionType, string>> = {
  CRIAR_CARD: "Criar oportunidade no CRM",
  ATUALIZAR_CARD: "Atualizar card existente",
  APLICAR_ETIQUETAS: "Aplicar etiquetas",
  ATRIBUIR_RESPONSAVEL: "Atribuir responsável",
  MARCAR_ANALISADA: "Marcar como analisada",
  IGNORAR_RECOMENDACAO: "Ignorar recomendação",
};

export function IntelligenceCenter({
  accountId,
  userId,
}: {
  accountId: string;
  userId: string;
}) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [tab, setTab] = useState<TabKey>("oportunidades");

  const [filters, setFilters] = useState<FilterState>({
    preset: "30d",
    teamId: "",
    agentId: "",
    priority: "",
  });

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [busyAction, setBusyAction] = useState<ActionType | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "warning"; text: string } | null>(null);

  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSuggestions, setChatSuggestions] = useState<readonly string[]>([]);
  const [chatSending, setChatSending] = useState(false);

  /**
   * Token de recarga. Incrementá-lo dispara o efeito de busca novamente,
   * mantendo TODA a atualização de estado depois do `await` — é o que evita
   * as renderizações em cascata de um setState síncrono dentro do efeito.
   */
  const [reloadToken, setReloadToken] = useState(0);

  /* ----------------------------------------------------------------------
     Carregamento da visão geral
     ---------------------------------------------------------------------- */
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const data = await apiGet<OverviewResponse>(
          "/api/intelligence/overview",
          {
            accountId,
            userId,
            preset: filters.preset,
            teamId: filters.teamId || undefined,
            agentId: filters.agentId || undefined,
            priority: filters.priority || undefined,
          },
          controller.signal,
        );
        if (cancelled) return;
        setOverview(data);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(toErrorBody(caught));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSyncing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [accountId, userId, filters, reloadToken]);

  /**
   * Recarrega sob demanda. Chamado por manipuladores de evento (botão
   * "Atualizar análise", conclusão de uma ação), nunca de dentro de um efeito.
   */
  const reload = useCallback((options: { silent?: boolean } = {}) => {
    if (options.silent) setSyncing(true);
    else setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  /* ----------------------------------------------------------------------
     Auditoria (carregada sob demanda)
     ---------------------------------------------------------------------- */
  /** Recarrega a auditoria quando a aba é aberta ou após uma ação. */
  const [auditToken, setAuditToken] = useState(0);
  const reloadAudit = useCallback(() => setAuditToken((token) => token + 1), []);

  useEffect(() => {
    if (tab !== "historico") return;
    let cancelled = false;

    void (async () => {
      try {
        const data = await apiGet<AuditResponse>("/api/intelligence/audit", {
          accountId,
          userId,
          limit: 100,
        });
        if (!cancelled) setAudit(data);
      } catch (caught) {
        if (!cancelled) setError(toErrorBody(caught));
      } finally {
        if (!cancelled) setAuditLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tab, accountId, userId, auditToken]);

  /* ----------------------------------------------------------------------
     Chat
     ---------------------------------------------------------------------- */
  useEffect(() => {
    if (tab !== "chat" || chatSuggestions.length > 0) return;

    void apiGet<{ suggestions: readonly string[] }>("/api/intelligence/chat", {})
      .then((data) => setChatSuggestions(data.suggestions))
      .catch(() => setChatSuggestions([]));
  }, [tab, chatSuggestions.length]);

  const sendChat = useCallback(
    async (question: string) => {
      const userMessage: ChatMessage = {
        id: `local_${Date.now()}`,
        role: "user",
        content: question,
        createdAt: new Date().toISOString(),
      };
      setChatMessages((prev) => [...prev, userMessage]);
      setChatSending(true);

      try {
        const data = await apiSend<ChatResponse>("/api/intelligence/chat", {
          accountId,
          userId,
          question,
          preset: filters.preset,
          teamId: filters.teamId || undefined,
          agentId: filters.agentId || undefined,
        });
        setChatMessages((prev) => [...prev, data.message]);
        setChatSuggestions(data.suggestions);
      } catch (caught) {
        const body = toErrorBody(caught);
        setChatMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            role: "assistant",
            content: `Não consegui responder: ${body.message}`,
            createdAt: new Date().toISOString(),
            insufficientData: true,
          },
        ]);
      } finally {
        setChatSending(false);
      }
    },
    [accountId, userId, filters],
  );

  /* ----------------------------------------------------------------------
     Ações
     ---------------------------------------------------------------------- */
  const requestAction = useCallback(
    async (opportunity: Opportunity, actionType: ActionType) => {
      setBusyAction(actionType);
      try {
        const data = await apiSend<ActionResponse>("/api/intelligence/actions", {
          accountId,
          userId,
          opportunityId: opportunity.id,
          actionType,
          confirmed: false,
        });

        if (data.requiresConfirmation) {
          setPendingAction({
            opportunity,
            actionType,
            actionLabel: ACTION_LABELS[actionType] ?? actionType,
            reason: data.reason ?? "Confirme para aplicar.",
            preview: data.preview,
          });
        } else {
          setToast({ tone: "success", text: data.notice ?? "Ação registrada." });
          reload({ silent: true });
        }
      } catch (caught) {
        setToast({ tone: "warning", text: toErrorBody(caught).message });
      } finally {
        setBusyAction(null);
      }
    },
    [accountId, userId, reload],
  );

  const confirmAction = useCallback(async () => {
    if (!pendingAction) return;
    setSubmittingAction(true);

    try {
      const data = await apiSend<ActionResponse>("/api/intelligence/actions", {
        accountId,
        userId,
        opportunityId: pendingAction.opportunity.id,
        actionType: pendingAction.actionType,
        confirmed: true,
      });

      setPendingAction(null);
      setToast({
        tone: data.status === "EXECUTADA" ? "success" : "warning",
        text: data.notice ?? "Ação processada.",
      });
      reload({ silent: true });
      if (tab === "historico") reloadAudit();
    } catch (caught) {
      setToast({ tone: "warning", text: toErrorBody(caught).message });
    } finally {
      setSubmittingAction(false);
    }
  }, [pendingAction, accountId, userId, reload, reloadAudit, tab]);

  /* ----------------------------------------------------------------------
     Abrir atendimento — link gerado no servidor
     ---------------------------------------------------------------------- */
  const openSession = useCallback(
    async (opportunity: Opportunity) => {
      try {
        const link = await apiSend<{
          url: string;
          integratedLogin: boolean;
          notice?: string;
        }>("/api/intelligence/deep-link", {
          accountId,
          userId,
          sessionId: opportunity.sessionId,
        });

        if (link.notice) setToast({ tone: "warning", text: link.notice });
        window.open(link.url, "_blank", "noopener,noreferrer");
      } catch (caught) {
        setToast({ tone: "warning", text: toErrorBody(caught).message });
      }
    },
    [accountId, userId],
  );

  /* ----------------------------------------------------------------------
     Toast some sozinho
     ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const opportunities = useMemo(() => overview?.opportunities ?? [], [overview]);

  /* ----------------------------------------------------------------------
     Render
     ---------------------------------------------------------------------- */
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <FiltersBar
        filters={filters}
        onChange={setFilters}
        users={overview?.availableUsers ?? []}
        lastAnalysisAt={overview?.lastAnalysisAt}
        syncing={syncing}
        onRefresh={() => reload({ silent: true })}
        dataMode={overview?.dataMode ?? "mock"}
        canFilterTeam={overview?.context.role !== "VENDEDOR"}
      />

      {/* Avisos */}
      <div className="mt-4 space-y-3">
        {overview && !overview.integration.ready ? (
          <NoIntegrationBanner missing={overview.integration.missing} />
        ) : null}

        {overview ? <PendingValidationBanner items={overview.pendingValidation} /> : null}

        {toast ? (
          <Notice tone={toast.tone === "success" ? "success" : "warning"}>
            {toast.text}
          </Notice>
        ) : null}
      </div>

      {/* Indicadores */}
      <div className="mt-5">
        <KpiGrid kpis={overview?.kpis} loading={loading} />
      </div>

      {/* Abas */}
      <nav
        className="flowi-scroll mt-6 flex gap-1 overflow-x-auto border-b border-border-subtle"
        aria-label="Seções da inteligência comercial"
      >
        {TABS.map((item) => {
          const active = tab === item.key;
          const count =
            item.key === "oportunidades"
              ? opportunities.length
              : item.key === "recomendacoes"
                ? overview?.recommendations.length
                : undefined;

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-current={active ? "page" : undefined}
              className={cx(
                "relative whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "text-flowi-700 dark:text-flowi-300"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {item.label}
              {count !== undefined && count > 0 ? (
                <span className="ml-1.5 rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] tabular-nums">
                  {count}
                </span>
              ) : null}
              {active ? (
                <span className="absolute inset-x-0 -bottom-px h-0.5 flowi-gradient" />
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Conteúdo */}
      <div className="mt-5">
        {error ? (
          <ErrorState error={error} onRetry={() => reload()} />
        ) : loading ? (
          <LoadingSkeleton />
        ) : !overview ? (
          <LoadingSkeleton />
        ) : (
          <>
            {tab === "oportunidades" ? (
              opportunities.length === 0 ? (
                <NoOpportunities
                  onClearFilters={() =>
                    setFilters({ preset: "90d", teamId: "", agentId: "", priority: "" })
                  }
                />
              ) : (
                <div className="space-y-3">
                  {opportunities.map((opportunity) => (
                    <OpportunityCard
                      key={opportunity.id}
                      opportunity={opportunity}
                      onAction={requestAction}
                      onOpenSession={openSession}
                      busyAction={busyAction}
                    />
                  ))}
                </div>
              )
            ) : null}

            {tab === "funil" ? <FunnelTab funnels={overview.funnels} /> : null}
            {tab === "qualidade" ? <QualityTab reports={overview.qualityReports} /> : null}
            {tab === "recomendacoes" ? (
              <RecommendationsTab recommendations={overview.recommendations} />
            ) : null}

            {tab === "chat" ? (
              <div className="h-[640px]">
                <ChatPanel
                  messages={chatMessages}
                  suggestions={chatSuggestions}
                  sending={chatSending}
                  onSend={(question) => void sendChat(question)}
                />
              </div>
            ) : null}

            {tab === "historico" ? (
              <AuditTab
                entries={audit?.entries ?? []}
                loading={auditLoading}
                acceptanceRate={audit?.acceptanceRate ?? 0}
                scope={audit?.scope ?? "CONTA"}
              />
            ) : null}
          </>
        )}
      </div>

      {/* Rodapé com link para configurações */}
      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
        <p className="text-xs text-text-muted">
          Modo de automação atual:{" "}
          <span className="font-medium text-text-secondary">
            {overview?.settings.automationMode.replaceAll("_", " ").toLowerCase() ?? "—"}
          </span>
        </p>
        <a
          href={`/inteligencia-comercial/configuracoes?accountId=${encodeURIComponent(accountId)}&userId=${encodeURIComponent(userId)}`}
        >
          <Button variant="secondary" size="sm">
            Configurações
          </Button>
        </a>
      </footer>

      <ActionModal
        pending={pendingAction}
        submitting={submittingAction}
        onConfirm={() => void confirmAction()}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
