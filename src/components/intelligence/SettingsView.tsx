"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionType, AutomationMode } from "@/domain/enums";
import type { ApiErrorBody, IntegrationSettings, TaxonomyTag } from "@/domain/types";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Notice,
  Skeleton,
  Toggle,
} from "@/components/ui/primitives";
import { ErrorState } from "./StateViews";
import { apiGet, apiSend, toErrorBody } from "@/lib/api-client";
import { cx } from "@/lib/format";

/**
 * Página de configurações do Flowi Copilot Comercial.
 *
 * Concentra os modos de automação, a taxonomia de etiquetas e o diagnóstico
 * honesto da integração — incluindo a lista do que ainda não foi confirmado
 * na documentação oficial da API.
 */

interface SettingsResponse {
  settings: IntegrationSettings;
  canEdit: boolean;
  role: string;
  catalog: {
    modes: Record<AutomationMode, { title: string; description: string }>;
    lowRiskActions: { type: ActionType; label: string }[];
    alwaysConfirm: { type: ActionType; label: string }[];
    tagTaxonomy: TaxonomyTag[];
  };
  integration: {
    ready: boolean;
    missing: string[];
    dataMode: "mock" | "live";
    pendingEndpoints: {
      key: string;
      method: string;
      path: string;
      group: string;
      summary: string;
      pending: string[];
    }[];
  };
}

const MODE_ORDER: AutomationMode[] = ["OBSERVADOR", "COPILOTO", "AUTOMATICO_CONTROLADO"];

export function SettingsView({
  accountId,
  userId,
}: {
  accountId: string;
  userId: string;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Estado local editável
  const [mode, setMode] = useState<AutomationMode>("COPILOTO");
  const [autoActions, setAutoActions] = useState<ActionType[]>([]);
  const [retentionDays, setRetentionDays] = useState(180);
  const [allowTraining, setAllowTraining] = useState(false);

  /**
   * Token de recarga: incrementá-lo dispara o efeito de busca de novo,
   * mantendo as atualizações de estado depois do `await`.
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await apiGet<SettingsResponse>("/api/intelligence/settings", {
          accountId,
          userId,
        });
        if (cancelled) return;

        setData(response);
        setMode(response.settings.automationMode);
        setAutoActions(response.settings.guardrails.allowedAutoActions);
        setRetentionDays(response.settings.dataRetentionDays);
        setAllowTraining(response.settings.allowTrainingUsage);
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
  }, [accountId, userId, reloadToken]);

  /** Recarrega sob demanda, a partir de um manipulador de evento. */
  const reload = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);

    try {
      const response = await apiSend<{ settings: IntegrationSettings }>(
        "/api/intelligence/settings",
        {
          accountId,
          userId,
          automationMode: mode,
          allowedAutoActions: autoActions,
          dataRetentionDays: retentionDays,
          allowTrainingUsage: allowTraining,
        },
        "PUT",
      );

      setData((prev) => (prev ? { ...prev, settings: response.settings } : prev));
      setSaved(true);
    } catch (caught) {
      setError(toErrorBody(caught));
    } finally {
      setSaving(false);
    }
  }, [accountId, userId, mode, autoActions, retentionDays, allowTraining]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8 sm:px-6">
        <Skeleton className="h-8 w-64" />
        {[0, 1, 2].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-3 h-20 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <ErrorState error={error} onRetry={() => reload()} />
      </div>
    );
  }

  if (!data) return null;

  const readOnly = !data.canEdit;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 sm:px-6">
      <header>
        <a
          href={`/inteligencia-comercial?accountId=${encodeURIComponent(accountId)}&userId=${encodeURIComponent(userId)}`}
          className="text-xs font-medium text-flowi-600 hover:underline dark:text-flowi-300"
        >
          ← Voltar para a Central
        </a>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
          Configurações
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Modos de automação, taxonomia de etiquetas e estado da integração.
        </p>
      </header>

      {readOnly ? (
        <Notice tone="info" title="Somente leitura">
          Seu perfil ({data.role.toLowerCase()}) permite consultar estas configurações, mas
          apenas administradores podem alterá-las.
        </Notice>
      ) : null}

      {saved ? <Notice tone="success">Configurações salvas.</Notice> : null}
      {error ? <Notice tone="danger">{error.message}</Notice> : null}

      {/* ---------------- Modos de automação ---------------- */}
      <Card>
        <CardHeader
          title="Nível de automação"
          description="Define quanto a Flowi IA pode fazer sozinha. O padrão do produto é Copiloto."
        />
        <div className="space-y-3 p-4">
          {MODE_ORDER.map((key) => {
            const meta = data.catalog.modes[key];
            const active = mode === key;

            return (
              <label
                key={key}
                className={cx(
                  "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                  active
                    ? "border-flowi-400 bg-flowi-50 dark:border-flowi-600 dark:bg-flowi-950/40"
                    : "border-border-subtle hover:bg-surface-muted",
                  readOnly && "cursor-not-allowed opacity-70",
                )}
              >
                <input
                  type="radio"
                  name="automation-mode"
                  className="mt-1 accent-flowi-600"
                  checked={active}
                  disabled={readOnly}
                  onChange={() => setMode(key)}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">
                      {meta.title}
                    </span>
                    {key === "COPILOTO" ? <Badge>padrão</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted">
                    {meta.description}
                  </p>
                </div>
              </label>
            );
          })}
        </div>
      </Card>

      {/* ---------------- Ações de baixo risco ---------------- */}
      <Card>
        <CardHeader
          title="Ações de baixo risco autorizadas"
          description="Válidas apenas no modo Automático controlado. Nos demais modos, toda ação passa por confirmação."
        />
        <div className="space-y-3 p-4">
          {data.catalog.lowRiskActions.map((action) => (
            <Toggle
              key={action.type}
              label={action.label}
              checked={autoActions.includes(action.type)}
              disabled={readOnly || mode !== "AUTOMATICO_CONTROLADO"}
              onChange={(next) =>
                setAutoActions((prev) =>
                  next
                    ? [...prev, action.type]
                    : prev.filter((item) => item !== action.type),
                )
              }
            />
          ))}

          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/30">
            <p className="text-xs font-semibold text-rose-900 dark:text-rose-200">
              Sempre exigem confirmação humana
            </p>
            <p className="mt-1 text-[11px] text-rose-800 dark:text-rose-300">
              Estas ações não podem ser automatizadas por nenhuma configuração, em nenhum modo.
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {data.catalog.alwaysConfirm.map((action) => (
                <li key={action.type}>
                  <Badge className="bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-900/40 dark:text-rose-200 dark:ring-rose-800">
                    {action.label}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      {/* ---------------- Privacidade e retenção ---------------- */}
      <Card>
        <CardHeader
          title="Privacidade e retenção de dados"
          description="Controles de LGPD aplicados aos dados analisados pela IA."
        />
        <div className="space-y-4 p-4">
          <Field
            label="Retenção dos dados analisados (dias)"
            hint="Entre 30 e 1095 dias. Após esse prazo, as análises armazenadas devem ser descartadas."
            htmlFor="retention"
          >
            <Input
              id="retention"
              type="number"
              min={30}
              max={1095}
              value={retentionDays}
              disabled={readOnly}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
              className="max-w-40"
            />
          </Field>

          <Toggle
            label="Autorizar uso das conversas para treinamento de modelo"
            description="Desligado por padrão. As conversas dos seus clientes não são usadas para treinar modelos sem autorização explícita."
            checked={allowTraining}
            disabled={readOnly}
            onChange={setAllowTraining}
          />
        </div>
      </Card>

      {/* ---------------- Taxonomia de etiquetas ---------------- */}
      <Card>
        <CardHeader
          title="Taxonomia de etiquetas da IA"
          description="Catálogo fechado. A IA reutiliza etiquetas equivalentes já existentes e nunca cria novas sem aprovação administrativa."
        />
        <div className="flowi-scroll overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="border-b border-border-subtle bg-surface-muted text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Etiqueta</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Quando é aplicada</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Sinônimos reconhecidos</th>
              </tr>
            </thead>
            <tbody>
              {data.catalog.tagTaxonomy.map((tag) => (
                <tr key={tag.key} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-text-primary">{tag.name}</span>
                    <span className="mt-0.5 block text-[11px] text-text-muted">
                      {tag.description}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{tag.rule}</td>
                  <td className="px-4 py-2.5 text-text-muted">{tag.synonyms.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---------------- Diagnóstico da integração ---------------- */}
      <Card>
        <CardHeader
          title="Estado da integração"
          description={
            data.integration.ready
              ? "Integração ativa: as consultas usam a API da KlipFlowi."
              : "Integração inativa: o módulo opera com dados simulados."
          }
        />
        <div className="space-y-4 p-4">
          {data.integration.missing.length > 0 ? (
            <Notice tone="info" title="Variáveis de ambiente pendentes">
              <ul className="list-inside list-disc">
                {data.integration.missing.map((item) => (
                  <li key={item}>
                    <code className="text-[12px]">{item}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px]">
                Preencha no arquivo <code>.env.local</code> e reinicie a aplicação.
              </p>
            </Notice>
          ) : null}

          {data.integration.pendingEndpoints.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-text-primary">
                Contratos de API ainda não validados (
                {data.integration.pendingEndpoints.length})
              </p>
              <p className="mt-1 text-[11px] text-text-muted">
                Cada item abaixo tem caminho conhecido pelo índice oficial, mas algo ainda
                precisa ser confirmado na página detalhada do endpoint. Enquanto isso, as
                escritas correspondentes ficam bloqueadas de propósito.
              </p>

              <ul className="mt-3 space-y-2">
                {data.integration.pendingEndpoints.map((endpoint) => (
                  <li
                    key={endpoint.key}
                    className="rounded-lg border border-border-subtle p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-violet-brand-50 text-violet-brand-700 ring-violet-brand-200 dark:bg-violet-brand-950/40 dark:text-violet-brand-200 dark:ring-violet-brand-800">
                        {endpoint.method}
                      </Badge>
                      <code className="text-[11px] text-text-secondary">
                        {endpoint.group}
                        {endpoint.path || " (caminho desconhecido)"}
                      </code>
                    </div>
                    <p className="mt-1 text-[11px] text-text-muted">{endpoint.summary}</p>
                    <ul className="mt-1.5 list-inside list-disc text-[11px] text-text-muted">
                      {endpoint.pending.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Notice tone="success">
              Todos os contratos de API estão confirmados.
            </Notice>
          )}
        </div>
      </Card>

      {/* ---------------- Salvar ---------------- */}
      {!readOnly ? (
        <div className="flex justify-end gap-2 pb-6">
          <Button variant="ghost" onClick={() => reload()} disabled={saving}>
            Descartar alterações
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Salvando..." : "Salvar configurações"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
