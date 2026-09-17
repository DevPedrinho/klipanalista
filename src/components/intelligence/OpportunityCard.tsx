"use client";

import { useState } from "react";
import type { ActionType } from "@/domain/enums";
import type { IcpScore, Opportunity } from "@/domain/types";
import { Badge, Button, Card, ScoreBar } from "@/components/ui/primitives";
import {
  PRIORITY_CLASSES,
  PRIORITY_LABEL,
  brlExact,
  humanHours,
  initials,
  scoreColor,
  timeAgo,
} from "@/lib/format";

/**
 * Card de oportunidade.
 *
 * Mostra todos os campos exigidos pelo produto e, ao expandir, as evidencias
 * que sustentam a conclusao — nunca apenas o veredito.
 */

/*
 * Os rótulos "IA | ..." saíram daqui.
 *
 * O card mostrava a taxonomia interna do módulo. Medido contra a conta real:
 * nenhuma das 11 chaves tinha equivalente entre as 18 etiquetas existentes,
 * e como o produto nunca cria etiqueta sem aprovação, o que aparecia no card
 * era exatamente o que jamais seria aplicado. Agora o card mostra as
 * etiquetas DA CONTA. A taxonomia interna continua existindo, mas onde ela
 * sempre serviu: alimentando os indicadores.
 */

const BREAKDOWN_LABELS: Record<string, { label: string; max: number }> = {
  intencaoExplicita: { label: "Intenção explícita de compra", max: 30 },
  recencia: { label: "Recência da interação", max: 15 },
  clarezaNecessidade: { label: "Clareza da necessidade", max: 15 },
  maturidadeComercial: { label: "Maturidade comercial", max: 15 },
  proximoPasso: { label: "Existência de próximo passo", max: 10 },
  relacionamento: { label: "Relacionamento / recorrência", max: 10 },
  qualidadeDados: { label: "Qualidade dos dados", max: 5 },
};

export interface OpportunityCardProps {
  opportunity: Opportunity;
  onAction: (opportunity: Opportunity, actionType: ActionType) => void;
  onOpenSession: (opportunity: Opportunity) => void;
  busyAction?: ActionType | null;
  compact?: boolean;
}

export function OpportunityCard({
  opportunity: o,
  onAction,
  onOpenSession,
  busyAction,
  compact = false,
}: OpportunityCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(o.suggestedFollowUpMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard pode estar bloqueado no contexto de iframe do widget.
      setCopied(false);
    }
  }

  return (
    <Card as="article" className="overflow-hidden">
      {/* ---------------- Cabeçalho ---------------- */}
      <div className="flex flex-wrap items-start gap-3 border-b border-border-subtle p-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full flowi-gradient text-sm font-semibold text-white"
          aria-hidden="true"
        >
          {initials(o.contactName)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">
              {o.contactName}
            </h3>
            <Badge className={PRIORITY_CLASSES[o.priority]}>
              {PRIORITY_LABEL[o.priority]}
            </Badge>
            {o.cardId ? (
              <Badge title="Já existe card no CRM para este contato">no CRM</Badge>
            ) : (
              <Badge
                className="bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
                title="Nenhum card registrado no funil para esta oportunidade"
              >
                fora do CRM
              </Badge>
            )}
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
            {o.company ? <span className="truncate">{o.company}</span> : null}
            {o.contactPhoneMasked ? (
              <>
                {o.company ? <span aria-hidden="true">·</span> : null}
                <span title="Telefone mascarado por padrão">{o.contactPhoneMasked}</span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>{o.channel.toLowerCase()}</span>
            <span aria-hidden="true">·</span>
            <span>{o.agentName ?? "sem responsável"}</span>
          </p>
        </div>

        <div className="w-full shrink-0 sm:w-40">
          <ScoreBar
            value={o.score}
            colorClass={scoreColor(o.score)}
            label={`Score de oportunidade de ${o.contactName}`}
          />
          <p className="mt-1 text-right text-[11px] text-text-muted">
            confiança{" "}
            <span
              className="font-medium text-text-secondary"
              title="Quantidade e qualidade das evidências. É diferente do score."
            >
              {o.confidence}%
            </span>
          </p>
        </div>
      </div>

      {/* ---------------- Corpo ---------------- */}
      <div className="space-y-3 p-4">
        {o.productInterest ? (
          <p className="text-xs text-text-muted">
            Interesse:{" "}
            <span className="font-medium text-text-secondary">{o.productInterest}</span>
          </p>
        ) : null}

        <p className="line-clamp-3 text-sm leading-relaxed text-text-secondary">
          {o.needSummary}
        </p>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-text-muted">Última interação</dt>
            <dd className="mt-0.5 font-medium text-text-primary">
              {timeAgo(o.lastInteractionAt)}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Sem resposta</dt>
            <dd className="mt-0.5 font-medium text-text-primary">
              {humanHours(o.hoursWithoutReply)}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Etapa atual</dt>
            <dd className="mt-0.5 truncate font-medium text-text-primary">
              {o.currentStepName ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">Valor potencial</dt>
            <dd className="mt-0.5 font-medium text-text-primary">
              {brlExact(o.estimatedValue)}
              {o.estimatedValueIsInferred ? (
                <span
                  className="ml-1 text-[10px] font-normal text-amber-600 dark:text-amber-400"
                  title="Valor inferido pela IA a partir da conversa. Não confirmado por uma pessoa."
                >
                  estimado
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        {/* Motivo e próximo passo */}
        <div className="rounded-lg bg-surface-muted px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Por que foi identificada
          </p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{o.reason}</p>

          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Próxima ação recomendada
          </p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{o.nextAction}</p>
        </div>

        {/* ---------------- ICP: aderência do cliente ---------------- */}
        {o.icp ? <BlocoIcp icp={o.icp} /> : null}

        {/*
          Etiquetas DA CONTA, com o porquê de cada uma.

          São as etiquetas que a equipe já usa — não um vocabulário nosso —,
          e é isso que a ação de aplicar envia. Cada uma vem com o motivo e,
          quando a sugestão nasceu de uma menção, o trecho literal em que o
          cliente disse aquilo: quem aprova julga a evidência, não o rótulo.
        */}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          Etiquetas sugeridas para o contato
        </p>
        {o.suggestedAccountTags.length === 0 ? (
          <p className="text-xs text-text-muted">
            Nenhuma etiqueta desta conta se aplica a esta conversa.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {o.suggestedAccountTags.map((tag) => (
              <li key={tag.tagId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge className="bg-violet-brand-50 text-violet-brand-700 ring-violet-brand-200 dark:bg-violet-brand-950/50 dark:text-violet-brand-200 dark:ring-violet-brand-800">
                  {tag.tagName}
                </Badge>
                <span className="text-xs text-text-muted">{tag.motivo}</span>
                {tag.trecho ? (
                  <span className="w-full text-xs italic leading-relaxed text-text-secondary">
                    &ldquo;{tag.trecho}&rdquo;
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/*
          Objeções em bloco próprio, não em etiqueta.

          Uma etiqueta é um rótulo curto; uma objeção é a frase do cliente,
          como "infelizmente, no momento, eu não vou ter condição financeira
          de comprar essa máquina". Espremida num chip ao lado de rótulos de
          duas palavras, ela quebra a linha, desalinha a fileira e fica
          ilegível — e é justamente a informação que o vendedor precisa ler
          antes de responder.
        */}
        {o.objections.length > 0 ? (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Objeções que o cliente levantou
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {o.objections.map((objection) => (
                <li
                  key={objection}
                  className="border-l-2 border-rose-300 pl-2.5 text-xs leading-relaxed text-text-secondary dark:border-rose-800"
                >
                  &ldquo;{objection}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* ---------------- Análise completa ---------------- */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-medium text-flowi-600 hover:underline dark:text-flowi-300"
          aria-expanded={expanded}
        >
          {expanded ? "Ocultar análise completa" : "Ver análise completa"}
        </button>

        {expanded ? (
          <div className="space-y-4 rounded-lg border border-border-subtle p-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Evidências encontradas na conversa
              </p>
              {o.evidence.length === 0 ? (
                <p className="mt-1 text-xs text-text-muted">
                  Nenhuma evidência textual registrada.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {o.evidence.map((signal) => (
                    <li key={signal.code} className="text-xs">
                      <span className="font-medium text-text-primary">{signal.label}</span>
                      <blockquote className="mt-1 border-l-2 border-flowi-300 pl-2 italic text-text-muted">
                        “{signal.excerpt}”
                      </blockquote>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Composição do score
              </p>
              <ul className="mt-2 space-y-1.5">
                {Object.entries(o.scoreBreakdown).map(([key, value]) => {
                  const meta = BREAKDOWN_LABELS[key];
                  if (!meta) return null;
                  return (
                    <li key={key} className="flex items-center gap-2 text-xs">
                      <span className="w-44 shrink-0 truncate text-text-muted">
                        {meta.label}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset">
                        <div
                          className="h-full rounded-full bg-flowi-500"
                          style={{ width: `${(value / meta.max) * 100}%` }}
                        />
                      </div>
                      <span className="w-14 shrink-0 text-right tabular-nums text-text-secondary">
                        {value.toFixed(1)}/{meta.max}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Mensagem de follow-up sugerida
              </p>
              <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-muted p-3 font-sans text-xs leading-relaxed text-text-secondary">
                {o.suggestedFollowUpMessage}
              </pre>
            </div>

            {o.recommendedStepName ? (
              <p className="text-xs text-text-muted">
                Etapa recomendada no funil:{" "}
                <span className="font-medium text-text-secondary">
                  {o.recommendedStepName}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---------------- Ações ---------------- */}
      {!compact ? (
        <div className="flex flex-wrap gap-2 border-t border-border-subtle bg-surface-muted/60 p-3">
          <Button size="sm" variant="primary" onClick={() => onOpenSession(o)}>
            Abrir atendimento
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setExpanded(true)}>
            Ver análise
          </Button>
          <Button size="sm" variant="secondary" onClick={copyMessage}>
            {copied ? "Copiado!" : "Copiar mensagem"}
          </Button>

          {o.cardId ? (
            <Button
              size="sm"
              variant="subtle"
              disabled={busyAction === "ATUALIZAR_CARD"}
              onClick={() => onAction(o, "ATUALIZAR_CARD")}
            >
              Atualizar card
            </Button>
          ) : (
            <Button
              size="sm"
              variant="subtle"
              disabled={busyAction === "CRIAR_CARD"}
              onClick={() => onAction(o, "CRIAR_CARD")}
            >
              Criar oportunidade
            </Button>
          )}

          <Button
            size="sm"
            variant="subtle"
            disabled={busyAction === "APLICAR_ETIQUETAS"}
            onClick={() => onAction(o, "APLICAR_ETIQUETAS")}
          >
            Aplicar etiquetas
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAction(o, "ATRIBUIR_RESPONSAVEL")}
          >
            Atribuir responsável
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAction(o, "MARCAR_ANALISADA")}>
            Marcar analisada
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAction(o, "IGNORAR_RECOMENDACAO")}>
            Ignorar
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/* ==========================================================================
   ICP — aderência do cliente ao perfil ideal
   ==========================================================================
   Fica separado do score de oportunidade de propósito, e a tela precisa
   deixar isso óbvio: são perguntas diferentes.

     score de oportunidade -> quanto este negócio merece atenção AGORA
     ICP                   -> quanto este cliente se parece com quem compra

   Um cliente com ICP alto e prazo distante não é urgente, mas vale cultivar.
   Um com ICP baixo pedindo orçamento hoje é urgente e provavelmente não
   fecha. Um número só apagaria justamente a diferença que faz o vendedor
   escolher onde gastar a próxima hora.
   ========================================================================== */

const FAIXA_ICP: Record<IcpScore["faixa"], { rotulo: string; classe: string }> = {
  ALTO: {
    rotulo: "Alta aderência",
    classe:
      "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
  },
  MEDIO: {
    rotulo: "Aderência parcial",
    classe:
      "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
  },
  BAIXO: {
    rotulo: "Baixa aderência",
    classe:
      "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-200 dark:ring-slate-700",
  },
};

function BlocoIcp({ icp }: { icp: IcpScore }) {
  const faixa = FAIXA_ICP[icp.faixa];

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          ICP — aderência do cliente
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{icp.total}/100</span>
          <Badge className={faixa.classe}>{faixa.rotulo}</Badge>
        </div>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
        {icp.perfilResumido}
      </p>

      <ul className="mt-3 space-y-2">
        {icp.dimensoes.map((d) => {
          const proporcao = d.maximo > 0 ? d.nota / d.maximo : 0;

          return (
            <li key={d.chave}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-text-primary">{d.rotulo}</span>
                <span className="text-[11px] tabular-nums text-text-muted">
                  {d.nota}/{d.maximo}
                </span>
              </div>

              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-inset"
                role="img"
                aria-label={`${d.rotulo}: ${d.nota} de ${d.maximo}`}
              >
                <div
                  className="h-full rounded-full bg-flowi-500"
                  style={{ width: `${Math.round(proporcao * 100)}%` }}
                />
              </div>

              <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                {d.justificativa}
              </p>

              {/*
                A evidência é o ponto do produto: nenhuma nota aparece sem que
                dê para ver a frase que a sustenta. Quando a conversa não falou
                do assunto, o silêncio é dito — é diferente de nota baixa por
                mérito.
              */}
              {d.evidencia ? (
                <p className="mt-1 border-l-2 border-border-subtle pl-2 text-[11px] italic leading-relaxed text-text-muted">
                  “{d.evidencia}”
                </p>
              ) : d.evidenciaRejeitada ? (
                <p className="mt-1 text-[11px] leading-relaxed text-rose-600 dark:text-rose-300">
                  A citação não foi encontrada na conversa; a nota foi zerada.
                </p>
              ) : (
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                  A conversa não trouxe nada sobre isto.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
