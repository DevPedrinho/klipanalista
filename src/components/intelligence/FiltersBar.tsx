"use client";

import type { Priority } from "@/domain/enums";
import { Button, Select } from "@/components/ui/primitives";
import { cx, dateTime } from "@/lib/format";

/** Cabeçalho com filtros e indicador de sincronização. */

export interface FilterState {
  preset: "7d" | "15d" | "30d" | "90d";
  teamId: string;
  agentId: string;
  priority: "" | Priority;
}

export interface UserOption {
  id: string;
  name: string;
  teamId?: string;
  teamName?: string;
}

export function FiltersBar({
  filters,
  onChange,
  users,
  lastAnalysisAt,
  syncing,
  onRefresh,
  dataMode,
  canFilterTeam,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  users: UserOption[];
  lastAnalysisAt?: string;
  syncing: boolean;
  onRefresh: () => void;
  dataMode: "mock" | "live";
  canFilterTeam: boolean;
}) {
  const teams = [...new Map(
    users
      .filter((u) => u.teamId)
      .map((u) => [u.teamId as string, u.teamName ?? u.teamId as string]),
  ).entries()];

  const visibleUsers = filters.teamId
    ? users.filter((u) => u.teamId === filters.teamId)
    : users;

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
              Inteligência Comercial
            </h1>
            <span
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                dataMode === "live"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900"
                  : "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
              )}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 rounded-full",
                  dataMode === "live" ? "bg-emerald-500" : "bg-amber-500",
                )}
                aria-hidden="true"
              />
              {dataMode === "live" ? "dados reais" : "dados simulados"}
            </span>
          </div>

          <p className="mt-1 text-sm text-text-muted">
            Seu consultor de CRM e inteligência comercial.
          </p>

          <p className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
            {syncing ? (
              <>
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-flowi-500"
                  aria-hidden="true"
                />
                Sincronizando análise...
              </>
            ) : (
              <>
                Última análise:{" "}
                <span className="font-medium text-text-secondary">
                  {lastAnalysisAt ? dateTime(lastAnalysisAt) : "—"}
                </span>
              </>
            )}
          </p>
        </div>

        <Button variant="primary" onClick={onRefresh} disabled={syncing}>
          {syncing ? "Atualizando..." : "Atualizar análise"}
        </Button>
      </div>

      {/* Filtros */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select
          aria-label="Período"
          value={filters.preset}
          onChange={(e) =>
            onChange({ ...filters, preset: e.target.value as FilterState["preset"] })
          }
        >
          <option value="7d">Últimos 7 dias</option>
          <option value="15d">Últimos 15 dias</option>
          <option value="30d">Últimos 30 dias</option>
          <option value="90d">Últimos 90 dias</option>
        </Select>

        <Select
          aria-label="Equipe"
          value={filters.teamId}
          disabled={!canFilterTeam}
          title={
            canFilterTeam
              ? undefined
              : "Seu perfil permite ver apenas os próprios atendimentos."
          }
          onChange={(e) => onChange({ ...filters, teamId: e.target.value, agentId: "" })}
        >
          <option value="">Todas as equipes</option>
          {teams.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Vendedor"
          value={filters.agentId}
          onChange={(e) => onChange({ ...filters, agentId: e.target.value })}
        >
          <option value="">Todos os vendedores</option>
          {visibleUsers.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Prioridade"
          value={filters.priority}
          onChange={(e) =>
            onChange({ ...filters, priority: e.target.value as FilterState["priority"] })
          }
        >
          <option value="">Todas as prioridades</option>
          <option value="CRITICA">Crítica</option>
          <option value="ALTA">Alta</option>
          <option value="MEDIA">Média</option>
          <option value="BAIXA">Baixa</option>
        </Select>
      </div>
    </header>
  );
}
