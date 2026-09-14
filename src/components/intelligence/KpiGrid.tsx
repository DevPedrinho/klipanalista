"use client";

import type { IntelligenceKpis } from "@/domain/types";
import { Card, Skeleton } from "@/components/ui/primitives";
import { brl, compactNumber, cx } from "@/lib/format";

/**
 * Faixa de indicadores da Central de Inteligencia Comercial.
 *
 * Cada indicador traz uma explicacao curta no atributo `title`, para que o
 * numero nunca precise ser interpretado por adivinhacao.
 */

interface KpiDefinition {
  key: keyof IntelligenceKpis;
  label: string;
  help: string;
  format: "number" | "currency" | "percent";
  emphasis?: boolean;
}

const KPIS: KpiDefinition[] = [
  {
    key: "oportunidadesEncontradas",
    label: "Oportunidades encontradas",
    help: "Conversas com score igual ou acima de 30 pontos no período e escopo selecionados.",
    format: "number",
    emphasis: true,
  },
  {
    key: "oportunidadesAltaPrioridade",
    label: "Alta prioridade",
    help: "Oportunidades com score igual ou acima de 75 pontos (inclui as críticas).",
    format: "number",
    emphasis: true,
  },
  {
    key: "valorPotencialEstimado",
    label: "Valor potencial estimado",
    help: "Soma dos valores dos cards vinculados e dos valores citados nas conversas. Valores inferidos pela IA estão sinalizados em cada oportunidade.",
    format: "currency",
    emphasis: true,
  },
  {
    key: "clientesSemRetorno",
    label: "Clientes sem retorno",
    help: "Oportunidades com mais de 24 horas desde a última mensagem.",
    format: "number",
  },
  {
    key: "oportunidadesParadas",
    label: "Oportunidades paradas",
    help: "Mais de 7 dias sem qualquer interação.",
    format: "number",
  },
  {
    key: "cardsEtapaProvavelmenteErrada",
    label: "Cards em etapa errada",
    help: "Cards cuja etapa atual não corresponde ao estágio indicado pela conversa.",
    format: "number",
  },
  {
    key: "contatosSemClassificacao",
    label: "Contatos sem etiqueta",
    help: "Contatos da conta sem nenhuma etiqueta aplicada.",
    format: "number",
  },
  {
    key: "atendimentosComIntencaoCompra",
    label: "Com intenção de compra",
    help: "Atendimentos em que a IA identificou ao menos um sinal positivo de compra.",
    format: "number",
  },
  {
    key: "oportunidadesRecuperadasPelaIa",
    label: "Recuperadas pela IA",
    help: "Oportunidades relevantes que não tinham card no CRM e estavam sem retorno — teriam passado despercebidas.",
    format: "number",
  },
  {
    key: "taxaAproveitamentoSugestoes",
    label: "Aproveitamento das sugestões",
    help: "Percentual de sugestões aplicadas entre as que tiveram um desfecho (aplicadas ou descartadas).",
    format: "percent",
  },
];

function formatValue(value: number, format: KpiDefinition["format"]): string {
  if (format === "currency") return brl(value);
  if (format === "percent") return `${value}%`;
  return value >= 10000 ? compactNumber(value) : String(value);
}

export function KpiGrid({
  kpis,
  loading,
}: {
  kpis?: IntelligenceKpis;
  loading: boolean;
}) {
  if (loading || !kpis) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {KPIS.map((kpi) => (
          <Card key={kpi.key} className="p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {KPIS.map((kpi) => {
        const value = kpis[kpi.key];
        return (
          <Card
            key={kpi.key}
            className={cx(
              "p-4 transition-shadow hover:shadow-md",
              kpi.emphasis && "ring-1 ring-flowi-100 dark:ring-flowi-900",
            )}
          >
            <p
              className="line-clamp-2 text-[11px] font-medium leading-snug text-text-muted"
              title={kpi.help}
            >
              {kpi.label}
            </p>
            <p
              className={cx(
                "mt-2 text-2xl font-semibold tabular-nums",
                kpi.emphasis ? "flowi-gradient-text" : "text-text-primary",
              )}
            >
              {formatValue(value, kpi.format)}
            </p>
          </Card>
        );
      })}
    </div>
  );
}
