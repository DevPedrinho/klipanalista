"use client";

import type {
  AgentQualityReport,
  FunnelSummary,
  Recommendation,
  AuditLogEntry,
} from "@/domain/types";
import { Badge, Card, CardHeader, EmptyState, Skeleton } from "@/components/ui/primitives";
import { brl, cx, dateTime } from "@/lib/format";

/* ==========================================================================
   Aba: Funil e CRM
   ========================================================================== */
export function FunnelTab({ funnels }: { funnels: FunnelSummary[] }) {
  if (funnels.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nenhum painel encontrado"
          description="Não há painéis de CRM disponíveis para esta conta no período selecionado."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {funnels.map((funnel) => {
        const maxCards = Math.max(1, ...funnel.steps.map((s) => s.cardCount));
        const total = funnel.steps.reduce((acc, s) => acc + s.totalValue, 0);

        return (
          <Card key={funnel.panelId}>
            <CardHeader
              title={funnel.panelName}
              description={`${funnel.panelType === "SALES" ? "Funil de vendas" : "Painel de gestão"} · ${brl(total)} em aberto`}
            />

            <div className="space-y-3 p-4">
              {funnel.steps.map((step) => (
                <div key={step.stepId}>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-text-primary">
                      {step.stepName}
                    </span>
                    <span className="text-xs text-text-muted">
                      {step.cardCount} card{step.cardCount === 1 ? "" : "s"} ·{" "}
                      {brl(step.totalValue)}
                      {step.stalledCount > 0 ? (
                        <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                          {step.stalledCount} parado{step.stalledCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-inset">
                    <div
                      className="h-full rounded-full flowi-gradient transition-all"
                      style={{ width: `${(step.cardCount / maxCards) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {funnel.misplacedCards.length > 0 ? (
              <div className="border-t border-border-subtle p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  Cards possivelmente na etapa errada
                </p>
                <ul className="mt-2 space-y-2">
                  {funnel.misplacedCards.map((card) => (
                    <li
                      key={card.cardId}
                      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30"
                    >
                      <p className="font-medium text-text-primary">{card.title}</p>
                      <p className="mt-1 text-text-secondary">
                        Está em <strong>{card.currentStepName}</strong>, parece pertencer a{" "}
                        <strong>{card.recommendedStepName}</strong>{" "}
                        <span className="text-text-muted">
                          (confiança {card.confidence}%)
                        </span>
                      </p>
                      <p className="mt-1 text-text-muted">{card.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   Aba: Qualidade dos atendimentos
   ========================================================================== */
export function QualityTab({ reports }: { reports: AgentQualityReport[] }) {
  if (reports.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Sem atendimentos para analisar"
          description="Não há conversas atribuídas a vendedores no período e escopo selecionados."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-surface-muted px-4 py-3 text-xs leading-relaxed text-text-muted">
        Esta análise existe para <strong>orientar e desenvolver</strong> a equipe, não para
        punir. Os critérios apontam onde a conversão pode crescer — use como pauta de
        conversa, não como ranking.
      </p>

      {reports.map((report) => (
        <Card key={report.agentId}>
          <CardHeader
            title={report.agentName}
            description={`${report.teamName ?? "sem equipe"} · ${report.conversationsAnalyzed} atendimento(s) analisado(s)`}
            action={
              <div className="text-right">
                <p className="text-2xl font-semibold tabular-nums flowi-gradient-text">
                  {report.overallScore}
                </p>
                <p className="text-[10px] text-text-muted">índice geral</p>
              </div>
            }
          />

          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Critérios
              </p>
              <ul className="space-y-2">
                {report.criteria.map((criterion) => (
                  <li key={criterion.key}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-text-secondary">{criterion.label}</span>
                      <Badge
                        className={cx(
                          criterion.status === "BOM" &&
                            "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
                          criterion.status === "ATENCAO" &&
                            "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
                          criterion.status === "CRITICO" &&
                            "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900",
                        )}
                      >
                        {criterion.score}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                      {criterion.note}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-surface-muted p-3">
                  <p className="text-[11px] text-text-muted">1ª resposta</p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">
                    {report.firstResponseTimeMinutes} min
                  </p>
                </div>
                <div className="rounded-lg bg-surface-muted p-3">
                  <p className="text-[11px] text-text-muted">Tempo médio</p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">
                    {report.averageResponseTimeMinutes} min
                  </p>
                </div>
              </div>

              {report.strengths.length > 0 ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                    Pontos fortes
                  </p>
                  <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
                    {report.strengths.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {report.developmentAreas.length > 0 ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-flowi-700 dark:text-flowi-300">
                    Áreas de desenvolvimento
                  </p>
                  <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
                    {report.developmentAreas.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="rounded-lg border border-flowi-200 bg-flowi-50 p-3 dark:border-flowi-800 dark:bg-flowi-950/40">
                <p className="text-xs leading-relaxed text-text-secondary">
                  {report.coachingSuggestion}
                </p>
              </div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ==========================================================================
   Aba: Recomendações
   ========================================================================== */
const IMPACT_CLASSES: Record<Recommendation["impact"], string> = {
  ALTO: "bg-violet-brand-100 text-violet-brand-800 ring-violet-brand-200 dark:bg-violet-brand-900/40 dark:text-violet-brand-200 dark:ring-violet-brand-800",
  MEDIO: "bg-flowi-100 text-flowi-800 ring-flowi-200 dark:bg-flowi-900/40 dark:text-flowi-200 dark:ring-flowi-800",
  BAIXO: "bg-surface-muted text-text-secondary ring-border-subtle",
};

export function RecommendationsTab({
  recommendations,
}: {
  recommendations: Recommendation[];
}) {
  if (recommendations.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nenhuma recomendação no momento"
          description="A IA não encontrou ações estruturais a recomendar para o período selecionado. Isso costuma ser um bom sinal."
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {recommendations.map((rec) => (
        <Card key={rec.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-text-primary">{rec.title}</h3>
            <div className="flex shrink-0 gap-1.5">
              <Badge className={IMPACT_CLASSES[rec.impact]}>impacto {rec.impact.toLowerCase()}</Badge>
              <Badge>esforço {rec.effort.toLowerCase()}</Badge>
            </div>
          </div>

          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {rec.description}
          </p>

          <div className="mt-3 rounded-lg bg-surface-muted px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Evidência
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">{rec.evidenceSummary}</p>
          </div>

          <p className="mt-2 text-[11px] text-text-muted">
            {rec.affectedCount} registro(s) afetado(s) · categoria {rec.category.toLowerCase()}
          </p>
        </Card>
      ))}
    </div>
  );
}

/* ==========================================================================
   Aba: Histórico de ações (auditoria)
   ========================================================================== */
const STATUS_CLASSES: Record<string, string> = {
  EXECUTADA:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
  APROVADA:
    "bg-flowi-50 text-flowi-700 ring-flowi-200 dark:bg-flowi-950/40 dark:text-flowi-200 dark:ring-flowi-900",
  AGUARDANDO_APROVACAO:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
  BLOQUEADA_POR_MODO:
    "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:ring-slate-700",
  REJEITADA:
    "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900",
  FALHOU:
    "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900",
  SUGERIDA: "bg-surface-muted text-text-secondary ring-border-subtle",
};

export function AuditTab({
  entries,
  loading,
  acceptanceRate,
  scope,
}: {
  entries: AuditLogEntry[];
  loading: boolean;
  acceptanceRate: number;
  scope: string;
}) {
  if (loading) {
    return (
      <Card className="p-4">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nenhuma ação registrada ainda"
          description="Assim que você aplicar ou descartar uma sugestão da Flowi IA, o registro completo aparece aqui — com evidências, estado anterior e posterior."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Histórico de ações"
        description={`${entries.length} registro(s) · escopo: ${scope.toLowerCase()} · aproveitamento das sugestões: ${acceptanceRate}%`}
      />

      <div className="flowi-scroll overflow-x-auto">
        <table className="w-full min-w-[880px] text-left text-xs">
          <thead className="border-b border-border-subtle bg-surface-muted">
            <tr className="text-text-muted">
              <th scope="col" className="px-4 py-2.5 font-medium">Data e hora</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Usuário</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Ação</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Alvo</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Situação</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Confiança</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Modo</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                className="border-b border-border-subtle last:border-0 hover:bg-surface-muted/50"
              >
                <td className="whitespace-nowrap px-4 py-2.5 text-text-muted">
                  {dateTime(entry.occurredAt)}
                </td>
                <td className="px-4 py-2.5 text-text-secondary">{entry.requestedByName}</td>
                <td className="px-4 py-2.5">
                  <span className="font-medium text-text-primary">{entry.suggestion}</span>
                  {entry.evidenceCodes.length > 0 ? (
                    <span className="mt-0.5 block text-[10px] text-text-muted">
                      evidências: {entry.evidenceCodes.slice(0, 3).join(", ")}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2.5 text-text-secondary">{entry.targetLabel}</td>
                <td className="px-4 py-2.5">
                  <Badge className={STATUS_CLASSES[entry.actionStatus] ?? STATUS_CLASSES.SUGERIDA}>
                    {entry.actionStatus.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 tabular-nums text-text-secondary">
                  {entry.aiConfidence}%
                </td>
                <td className="px-4 py-2.5 text-text-muted">
                  {entry.automationMode.replaceAll("_", " ").toLowerCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
