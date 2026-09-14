"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionType, WidgetOrigin } from "@/domain/enums";
import type {
  ApiErrorBody,
  ChatMessage,
  IntegrationSettings,
  IntelligenceKpis,
  Opportunity,
  WidgetContext,
} from "@/domain/types";
import { Button, Card, EmptyState, Notice, Skeleton } from "@/components/ui/primitives";
import { ActionModal, type ActionPreview, type PendingAction } from "./ActionModal";
import { ChatPanel } from "./ChatPanel";
import { OpportunityCard } from "./OpportunityCard";
import { ErrorState } from "./StateViews";
import { apiGet, apiSend, toErrorBody } from "@/lib/api-client";
import { cx } from "@/lib/format";

/**
 * Widget contextual.
 *
 * Aberto em popup por uma ação personalizada dentro do atendimento ou do CRM.
 * Analisa prioritariamente o cliente, atendimento ou card de onde foi aberto.
 */

interface WidgetResponse {
  widget: WidgetContext;
  focused: Opportunity | null;
  notFoundReason?: string;
  related: Opportunity[];
  kpis: IntelligenceKpis;
  settings: IntegrationSettings;
  role: string;
}

interface ActionResponse {
  status: string;
  requiresConfirmation?: boolean;
  reason?: string;
  preview: ActionPreview;
  notice?: string;
}

const ACTION_LABELS: Partial<Record<ActionType, string>> = {
  CRIAR_CARD: "Criar oportunidade no CRM",
  ATUALIZAR_CARD: "Atualizar card existente",
  APLICAR_ETIQUETAS: "Aplicar etiquetas",
  ATRIBUIR_RESPONSAVEL: "Atribuir responsável",
  MARCAR_ANALISADA: "Marcar como analisada",
  IGNORAR_RECOMENDACAO: "Ignorar recomendação",
};

export function WidgetView({
  accountId,
  userId,
  contactId,
  sessionId,
  cardId,
  origin,
}: {
  accountId: string;
  userId: string;
  contactId?: string;
  sessionId?: string;
  cardId?: string;
  origin: WidgetOrigin;
}) {
  const [data, setData] = useState<WidgetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [view, setView] = useState<"analise" | "chat">("analise");

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyAction, setBusyAction] = useState<ActionType | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSuggestions, setChatSuggestions] = useState<readonly string[]>([]);
  const [chatSending, setChatSending] = useState(false);

  /**
   * Token de recarga: mantém as atualizações de estado depois do `await`,
   * em vez de setá-las de forma síncrona dentro do efeito.
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await apiGet<WidgetResponse>("/api/intelligence/widget", {
          accountId,
          userId,
          contactId,
          sessionId,
          cardId,
          origin,
        });
        if (cancelled) return;
        setData(response);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(toErrorBody(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, userId, contactId, sessionId, cardId, origin, reloadToken]);

  /** Recarrega sob demanda, a partir de um manipulador de evento. */
  const reload = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (view !== "chat" || chatSuggestions.length > 0) return;
    void apiGet<{ suggestions: readonly string[] }>("/api/intelligence/chat", {})
      .then((d) => setChatSuggestions(d.suggestions))
      .catch(() => setChatSuggestions([]));
  }, [view, chatSuggestions.length]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const sendChat = useCallback(
    async (question: string) => {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `local_${Date.now()}`,
          role: "user",
          content: question,
          createdAt: new Date().toISOString(),
        },
      ]);
      setChatSending(true);

      try {
        const response = await apiSend<{ message: ChatMessage; suggestions: readonly string[] }>(
          "/api/intelligence/chat",
          {
            accountId,
            userId,
            question,
            // Ancora a resposta na oportunidade de onde o widget foi aberto.
            focusedOpportunityId: data?.focused?.id,
          },
        );
        setChatMessages((prev) => [...prev, response.message]);
        setChatSuggestions(response.suggestions);
      } catch (caught) {
        setChatMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            role: "assistant",
            content: `Não consegui responder: ${toErrorBody(caught).message}`,
            createdAt: new Date().toISOString(),
            insufficientData: true,
          },
        ]);
      } finally {
        setChatSending(false);
      }
    },
    [accountId, userId, data?.focused?.id],
  );

  const requestAction = useCallback(
    async (opportunity: Opportunity, actionType: ActionType) => {
      setBusyAction(actionType);
      try {
        const response = await apiSend<ActionResponse>("/api/intelligence/actions", {
          accountId,
          userId,
          opportunityId: opportunity.id,
          actionType,
          confirmed: false,
        });

        if (response.requiresConfirmation) {
          setPendingAction({
            opportunity,
            actionType,
            actionLabel: ACTION_LABELS[actionType] ?? actionType,
            reason: response.reason ?? "Confirme para aplicar.",
            preview: response.preview,
          });
        } else {
          setToast(response.notice ?? "Ação registrada.");
          reload();
        }
      } catch (caught) {
        setToast(toErrorBody(caught).message);
      } finally {
        setBusyAction(null);
      }
    },
    [accountId, userId, reload],
  );

  const confirmAction = useCallback(async () => {
    if (!pendingAction) return;
    setSubmitting(true);

    try {
      const response = await apiSend<ActionResponse>("/api/intelligence/actions", {
        accountId,
        userId,
        opportunityId: pendingAction.opportunity.id,
        actionType: pendingAction.actionType,
        confirmed: true,
      });
      setPendingAction(null);
      setToast(response.notice ?? "Ação processada.");
      reload();
    } catch (caught) {
      setToast(toErrorBody(caught).message);
    } finally {
      setSubmitting(false);
    }
  }, [pendingAction, accountId, userId, reload]);

  const openSession = useCallback(
    async (opportunity: Opportunity) => {
      try {
        const link = await apiSend<{ url: string; notice?: string }>(
          "/api/intelligence/deep-link",
          { accountId, userId, sessionId: opportunity.sessionId },
        );
        if (link.notice) setToast(link.notice);
        window.open(link.url, "_blank", "noopener,noreferrer");
      } catch (caught) {
        setToast(toErrorBody(caught).message);
      }
    },
    [accountId, userId],
  );

  return (
    <div className="flex min-h-screen flex-col bg-surface-page">
      {/* Cabeçalho compacto */}
      <header className="flowi-gradient px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden="true">✦</span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Flowi Copilot Comercial</h1>
            <p className="truncate text-[11px] opacity-90">
              {origin === "atendimento"
                ? "Análise do atendimento aberto"
                : "Análise do card do CRM"}
            </p>
          </div>
        </div>

        <nav className="mt-3 flex gap-1" aria-label="Seções do widget">
          {(["analise", "chat"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={cx(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                view === key
                  ? "bg-white/20 text-white"
                  : "text-white/75 hover:bg-white/10",
              )}
            >
              {key === "analise" ? "Análise" : "Perguntar à IA"}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 p-3">
        {toast ? (
          <div className="mb-3">
            <Notice tone="warning">{toast}</Notice>
          </div>
        ) : null}

        {error ? (
          <ErrorState error={error} onRetry={() => reload()} />
        ) : loading ? (
          <Card className="p-4">
            <div className="flex gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          </Card>
        ) : view === "chat" ? (
          <div className="h-[calc(100vh-11rem)]">
            <ChatPanel
              messages={chatMessages}
              suggestions={chatSuggestions}
              sending={chatSending}
              onSend={(question) => void sendChat(question)}
              compact
            />
          </div>
        ) : (
          <div className="space-y-3">
            {data?.focused ? (
              <OpportunityCard
                opportunity={data.focused}
                onAction={requestAction}
                onOpenSession={openSession}
                busyAction={busyAction}
              />
            ) : (
              <Card>
                <EmptyState
                  title="Nenhuma oportunidade identificada aqui"
                  description={
                    data?.notFoundReason ??
                    "A Flowi IA não encontrou sinais comerciais suficientes neste atendimento."
                  }
                  action={
                    <Button variant="secondary" size="sm" onClick={() => setView("chat")}>
                      Perguntar à Flowi IA
                    </Button>
                  }
                />
              </Card>
            )}

            {data && data.related.length > 0 ? (
              <section>
                <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  Outras oportunidades no seu escopo
                </h2>
                <div className="space-y-2">
                  {data.related.map((opportunity) => (
                    <OpportunityCard
                      key={opportunity.id}
                      opportunity={opportunity}
                      onAction={requestAction}
                      onOpenSession={openSession}
                      busyAction={busyAction}
                      compact
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </main>

      <ActionModal
        pending={pendingAction}
        submitting={submitting}
        onConfirm={() => void confirmAction()}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
