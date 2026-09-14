import "server-only";
import type {
  AgentQualityReport,
  ChatCitation,
  ChatMessage,
  FunnelSummary,
  Opportunity,
  TenantContext,
} from "@/domain/types";

/**
 * Chat contextual da Flowi IA.
 *
 * REGRAS INEGOCIAVEIS (definidas no produto):
 *  - responder APENAS com dados ja carregados para aquele usuario e conta;
 *  - mostrar as evidencias que sustentam a resposta;
 *  - dizer claramente quando NAO ha dados suficientes;
 *  - nunca inventar informacao;
 *  - apresentar links para os atendimentos e cards citados;
 *  - respeitar as permissoes do vendedor e do gestor.
 *
 * IMPLEMENTACAO ATUAL: motor deterministico de intencao. Nao ha chamada a
 * provedor de LLM nesta entrega — `AI_PROVIDER_API_KEY` existe para a proxima
 * etapa. A vantagem de comecar deterministico e que a resposta so pode citar
 * o que esta no contexto recebido, o que torna a alucinacao impossivel.
 */

export interface ChatContext {
  tenant: TenantContext;
  opportunities: Opportunity[];
  funnels: FunnelSummary[];
  qualityReports: AgentQualityReport[];
  /** Contexto do widget, quando a pergunta vem de um atendimento ou card. */
  focusedOpportunityId?: string;
}

type Intent =
  | "MELHORES_OPORTUNIDADES"
  | "PORQUE_CLASSIFICADO"
  | "PRECISAM_FOLLOWUP"
  | "ANALISE_VENDEDOR"
  | "OBJECOES_FREQUENTES"
  | "MENSAGEM_FOLLOWUP"
  | "PROXIMO_PASSO"
  | "CARDS_ETAPA_ERRADA"
  | "RESUMO_FUNIL"
  | "ONDE_PERDEMOS"
  | "PODEM_RECOMPRAR"
  | "DESCONHECIDA";

interface IntentRule {
  intent: Intent;
  patterns: RegExp[];
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: "MELHORES_OPORTUNIDADES",
    patterns: [/melhor(es)?\s+oportunidade/i, /oportunidades?\s+de\s+hoje/i, /onde\s+devo\s+focar/i, /prioridade\s+hoje/i],
  },
  {
    intent: "PORQUE_CLASSIFICADO",
    patterns: [/por\s*que\s+(este|esse|o)\s+cliente/i, /por\s*que\s+foi\s+classificad/i, /qual\s+o\s+motivo/i, /quais\s+evid[êe]ncias/i],
  },
  {
    intent: "PRECISAM_FOLLOWUP",
    patterns: [/precisam?\s+de\s+follow/i, /quem\s+devo\s+retornar/i, /clientes?\s+sem\s+retorno/i, /follow[\s-]?up/i],
  },
  {
    intent: "ANALISE_VENDEDOR",
    patterns: [
      // Aceita "analise/análise", com ou sem artigo, e as contracoes de/do/da.
      /an[áa]lis[ei]\s+(?:o\s+|do\s+|da\s+)?atendimento(?:\s+d[eoa])?/i,
      /como\s+est[áa]\s+o\s+atendimento/i,
      /desempenho\s+d[oa]/i,
      /avali(?:e|ar)\s+(?:o\s+)?(?:vendedor|atendente|time|equipe)/i,
      /qualidade\s+d[oa]s?\s+atendimento/i,
    ],
  },
  {
    intent: "OBJECOES_FREQUENTES",
    patterns: [/obje[çc][õo]es/i, /principais\s+barreiras/i, /o\s+que\s+impede/i],
  },
  {
    intent: "MENSAGEM_FOLLOWUP",
    patterns: [/crie?\s+uma\s+mensagem/i, /escreva\s+(uma\s+)?mensagem/i, /sugest[ãa]o\s+de\s+mensagem/i, /como\s+abordar/i],
  },
  {
    intent: "PROXIMO_PASSO",
    patterns: [/pr[óo]ximo\s+passo/i, /o\s+que\s+fa[çc]o\s+agora/i, /como\s+seguir/i],
  },
  {
    intent: "CARDS_ETAPA_ERRADA",
    patterns: [/etapa\s+errada/i, /cards?\s+fora\s+do\s+lugar/i, /etapa\s+incorreta/i],
  },
  {
    intent: "RESUMO_FUNIL",
    patterns: [/resum[ao]\s+(meu\s+)?funil/i, /como\s+est[áa]\s+o\s+funil/i, /vis[ãa]o\s+geral\s+do\s+funil/i],
  },
  {
    intent: "ONDE_PERDEMOS",
    patterns: [/onde\s+(estamos\s+)?perdendo/i, /maior\s+perda/i, /gargalo/i],
  },
  {
    intent: "PODEM_RECOMPRAR",
    patterns: [/recompra/i, /comprar\s+novamente/i, /clientes?\s+recorrentes?/i],
  },
];

export function detectIntent(question: string): Intent {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((re) => re.test(question))) return rule.intent;
  }
  return "DESCONHECIDA";
}

/* --------------------------------------------------------------------------
   Formatadores
   -------------------------------------------------------------------------- */
function brl(value?: number): string {
  if (value === undefined) return "valor nao informado";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function opportunityCitation(opportunity: Opportunity): ChatCitation {
  return {
    label: `${opportunity.contactName}${opportunity.company ? ` (${opportunity.company})` : ""}`,
    // Rota interna: o deep link real e resolvido no servidor ao clicar.
    href: `/inteligencia-comercial?oportunidade=${encodeURIComponent(opportunity.id)}`,
    kind: "OPORTUNIDADE",
  };
}

function noData(question: string): { content: string; insufficientData: true } {
  return {
    content:
      `Nao tenho dados suficientes para responder "${question}" com seguranca.\n\n` +
      `Isso costuma acontecer quando o periodo selecionado nao tem atendimentos, ` +
      `quando o filtro de equipe ou vendedor esta muito restrito, ou quando a ` +
      `integracao ainda nao trouxe conversas.\n\n` +
      `Prefiro dizer que nao sei a arriscar um numero errado.`,
    insufficientData: true,
  };
}

/* --------------------------------------------------------------------------
   Respostas por intencao
   -------------------------------------------------------------------------- */
interface Answer {
  content: string;
  citations?: ChatCitation[];
  suggestedActions?: { label: string; opportunityId?: string }[];
  insufficientData?: boolean;
}

function answerBestOpportunities(ctx: ChatContext, question: string): Answer {
  const top = [...ctx.opportunities]
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0, 5);

  if (top.length === 0) return { ...noData(question) };

  const lines = top.map((o, index) => {
    const valor = o.estimatedValue !== undefined
      ? ` | ${brl(o.estimatedValue)}${o.estimatedValueIsInferred ? " (estimado)" : ""}`
      : "";
    return (
      `${index + 1}. **${o.contactName}**${o.company ? ` — ${o.company}` : ""}\n` +
      `   Score ${o.score}/100 · confianca ${o.confidence}% · ${o.priority.toLowerCase()}${valor}\n` +
      `   Motivo: ${o.reason}\n` +
      `   Proximo passo: ${o.nextAction}`
    );
  });

  return {
    content:
      `Estas sao as ${top.length} oportunidades com maior score no periodo e no ` +
      `escopo que voce enxerga:\n\n${lines.join("\n\n")}`,
    citations: top.map(opportunityCitation),
    suggestedActions: top.slice(0, 3).map((o) => ({
      label: `Abrir ${o.contactName}`,
      opportunityId: o.id,
    })),
  };
}

function answerWhyClassified(ctx: ChatContext, question: string): Answer {
  const focused = ctx.focusedOpportunityId
    ? ctx.opportunities.find((o) => o.id === ctx.focusedOpportunityId)
    : ctx.opportunities[0];

  if (!focused) return { ...noData(question) };

  const evidence = focused.evidence
    .map((e) => `- **${e.label}** — trecho: "${e.excerpt}"`)
    .join("\n");

  const breakdown = Object.entries(focused.scoreBreakdown)
    .map(([key, value]) => `   · ${key}: ${value.toFixed(1)} pts`)
    .join("\n");

  return {
    content:
      `**${focused.contactName}** foi classificado como ${focused.priority.toLowerCase()} ` +
      `com score ${focused.score}/100 e confianca ${focused.confidence}%.\n\n` +
      `**Evidencias encontradas na conversa:**\n${evidence || "- Nenhuma evidencia textual registrada."}\n\n` +
      `**Composicao do score:**\n${breakdown}\n\n` +
      `Lembrando: o score mede o quanto vale a pena priorizar; a confianca mede ` +
      `quanta evidencia sustenta essa leitura. Sao coisas diferentes.`,
    citations: [opportunityCitation(focused)],
  };
}

function answerFollowUps(ctx: ChatContext): Answer {
  const needing = ctx.opportunities
    .filter((o) => o.hoursWithoutReply >= 24)
    .sort((a, b) => b.hoursWithoutReply - a.hoursWithoutReply)
    .slice(0, 8);

  if (needing.length === 0) {
    return {
      content:
        "Nenhum cliente no escopo atual esta ha mais de 24 horas sem retorno. " +
        "O acompanhamento esta em dia para o periodo selecionado.",
    };
  }

  const lines = needing.map((o) => {
    const dias = Math.floor(o.hoursWithoutReply / 24);
    return `- **${o.contactName}** — ${dias} dia(s) sem retorno · score ${o.score} · ${o.nextAction}`;
  });

  return {
    content: `${needing.length} cliente(s) aguardando retorno:\n\n${lines.join("\n")}`,
    citations: needing.map(opportunityCitation),
    suggestedActions: needing.slice(0, 3).map((o) => ({
      label: `Ver ${o.contactName}`,
      opportunityId: o.id,
    })),
  };
}

function answerAgentAnalysis(ctx: ChatContext, question: string): Answer {
  if (ctx.qualityReports.length === 0) return { ...noData(question) };

  // Tenta identificar o vendedor citado na pergunta.
  const mentioned = ctx.qualityReports.find((r) =>
    question.toLowerCase().includes(r.agentName.split(/\s+/)[0]?.toLowerCase() ?? "\u0000"),
  );
  const report = mentioned ?? ctx.qualityReports[0];
  if (!report) return { ...noData(question) };

  const strengths = report.strengths.length > 0
    ? report.strengths.map((s) => `- ${s}`).join("\n")
    : "- Ainda sem dados suficientes para destacar pontos fortes.";

  const areas = report.developmentAreas.length > 0
    ? report.developmentAreas.map((s) => `- ${s}`).join("\n")
    : "- Nenhuma area critica identificada.";

  return {
    content:
      `**${report.agentName}** — ${report.conversationsAnalyzed} atendimento(s) analisado(s).\n\n` +
      `Indice geral: ${report.overallScore}/100\n` +
      `Primeira resposta: ${report.firstResponseTimeMinutes} min · ` +
      `tempo medio: ${report.averageResponseTimeMinutes} min\n\n` +
      `**Pontos fortes:**\n${strengths}\n\n` +
      `**Areas de desenvolvimento:**\n${areas}\n\n` +
      `${report.coachingSuggestion}\n\n` +
      `_Esta leitura serve para orientar e desenvolver, nao para punir._`,
  };
}

function answerObjections(ctx: ChatContext): Answer {
  const counts = new Map<string, number>();
  for (const opportunity of ctx.opportunities) {
    for (const objection of opportunity.objections) {
      counts.set(objection, (counts.get(objection) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return {
      content:
        "Nenhuma objecao explicita foi identificada nas conversas do periodo. " +
        "Isso pode significar que os clientes ainda nao chegaram na fase de decisao, " +
        "ou que as objecoes nao estao sendo trazidas a tona durante o atendimento.",
    };
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = ranked.map(([label, count]) => `- **${label}** — ${count} ocorrencia(s)`);

  return {
    content: `Objecoes mais frequentes no periodo:\n\n${lines.join("\n")}`,
  };
}

function answerFollowUpMessage(ctx: ChatContext, question: string): Answer {
  const focused = ctx.focusedOpportunityId
    ? ctx.opportunities.find((o) => o.id === ctx.focusedOpportunityId)
    : ctx.opportunities[0];

  if (!focused) return { ...noData(question) };

  return {
    content:
      `Sugestao de mensagem para **${focused.contactName}**:\n\n` +
      `---\n${focused.suggestedFollowUpMessage}\n---\n\n` +
      `Revise antes de enviar. Nenhuma mensagem e enviada ao cliente sem sua ` +
      `confirmacao explicita, em qualquer modo de automacao.`,
    citations: [opportunityCitation(focused)],
    suggestedActions: [{ label: "Copiar mensagem", opportunityId: focused.id }],
  };
}

function answerNextStep(ctx: ChatContext, question: string): Answer {
  const focused = ctx.focusedOpportunityId
    ? ctx.opportunities.find((o) => o.id === ctx.focusedOpportunityId)
    : ctx.opportunities[0];

  if (!focused) return { ...noData(question) };

  const objections = focused.objections.length > 0
    ? `\n\nObjecoes a tratar: ${focused.objections.join(", ")}.`
    : "";

  return {
    content:
      `Para **${focused.contactName}**, o proximo passo recomendado e:\n\n` +
      `${focused.nextAction}${objections}\n\n` +
      `Etapa sugerida no funil: ${focused.recommendedStepName ?? "nao definida"}.`,
    citations: [opportunityCitation(focused)],
  };
}

function answerMisplacedCards(ctx: ChatContext): Answer {
  const misplaced = ctx.funnels.flatMap((f) => f.misplacedCards);

  if (misplaced.length === 0) {
    return {
      content:
        "Nenhum card aparenta estar na etapa errada no periodo analisado. " +
        "As etapas atuais estao coerentes com o conteudo das conversas.",
    };
  }

  const lines = misplaced.map(
    (c) =>
      `- **${c.title}** — esta em "${c.currentStepName}", parece pertencer a ` +
      `"${c.recommendedStepName}" (confianca ${c.confidence}%)\n  Motivo: ${c.reason}`,
  );

  return {
    content: `${misplaced.length} card(s) possivelmente na etapa errada:\n\n${lines.join("\n")}`,
  };
}

function answerFunnelSummary(ctx: ChatContext, question: string): Answer {
  if (ctx.funnels.length === 0) return { ...noData(question) };

  const blocks = ctx.funnels.map((funnel) => {
    const steps = funnel.steps
      .map(
        (s) =>
          `   · ${s.stepName}: ${s.cardCount} card(s) · ${brl(s.totalValue)}` +
          (s.stalledCount > 0 ? ` · ${s.stalledCount} parado(s)` : ""),
      )
      .join("\n");
    return `**${funnel.panelName}**\n${steps}`;
  });

  const total = ctx.funnels.reduce(
    (acc, f) => acc + f.steps.reduce((sum, s) => sum + s.totalValue, 0),
    0,
  );

  return {
    content: `${blocks.join("\n\n")}\n\nValor total em aberto no funil: **${brl(total)}**.`,
  };
}

function answerWhereWeLose(ctx: ChatContext, question: string): Answer {
  if (ctx.funnels.length === 0) return { ...noData(question) };

  const allSteps = ctx.funnels.flatMap((f) =>
    f.steps.map((s) => ({ ...s, panelName: f.panelName })),
  );
  const worst = [...allSteps].sort((a, b) => b.stalledCount - a.stalledCount)[0];

  const stalledOpportunities = ctx.opportunities.filter((o) => o.hoursWithoutReply >= 24 * 7).length;

  if (!worst || worst.stalledCount === 0) {
    return {
      content:
        `Nenhuma etapa concentra cards parados no periodo. ` +
        `${stalledOpportunities} oportunidade(s) estao ha mais de 7 dias sem interacao — ` +
        `esse e o ponto de atencao mais relevante agora.`,
    };
  }

  return {
    content:
      `A maior concentracao de cards parados esta em **${worst.stepName}** ` +
      `(${worst.panelName}): ${worst.stalledCount} card(s) sem movimentacao, ` +
      `somando ${brl(worst.totalValue)}.\n\n` +
      `Alem disso, ${stalledOpportunities} oportunidade(s) estao ha mais de 7 dias ` +
      `sem qualquer interacao.\n\n` +
      `Sugestao: revisar essa etapa primeiro — e onde o funil esta represando valor.`,
  };
}

function answerRepurchase(ctx: ChatContext): Answer {
  const candidates = ctx.opportunities.filter((o) =>
    o.recommendedTagKeys.includes("RECOMPRA") ||
    o.evidence.some((e) => e.code === "RECOMPRA"),
  );

  if (candidates.length === 0) {
    return {
      content:
        "Nenhum cliente do periodo apresenta sinal claro de recompra. " +
        "Sinais de recompra aparecem quando o cliente menciona reposicao, novo pedido " +
        "ou repetir uma compra anterior.",
    };
  }

  const lines = candidates.map(
    (o) => `- **${o.contactName}**${o.company ? ` — ${o.company}` : ""} · score ${o.score} · ${o.nextAction}`,
  );

  return {
    content: `${candidates.length} cliente(s) com sinal de recompra:\n\n${lines.join("\n")}`,
    citations: candidates.map(opportunityCitation),
  };
}

function answerUnknown(ctx: ChatContext): Answer {
  return {
    content:
      "Ainda nao sei responder essa pergunta especifica. Posso ajudar com:\n\n" +
      "- Quais sao as melhores oportunidades de hoje?\n" +
      "- Por que este cliente foi classificado como oportunidade?\n" +
      "- Quais clientes precisam de follow-up?\n" +
      "- Analise o atendimento deste vendedor.\n" +
      "- Quais objecoes aparecem com maior frequencia?\n" +
      "- Crie uma mensagem de follow-up para este cliente.\n" +
      "- Qual deve ser o proximo passo desta negociacao?\n" +
      "- Quais cards parecem estar na etapa errada?\n" +
      "- Resuma meu funil comercial.\n" +
      "- Onde estamos perdendo mais oportunidades?\n" +
      "- Quais clientes podem comprar novamente?\n\n" +
      `No momento tenho ${ctx.opportunities.length} oportunidade(s) carregada(s) no seu escopo.`,
    insufficientData: true,
  };
}

/* --------------------------------------------------------------------------
   Entrada principal
   -------------------------------------------------------------------------- */
let messageSeq = 0;

export function answerQuestion(question: string, ctx: ChatContext): ChatMessage {
  const intent = detectIntent(question);

  let answer: Answer;
  switch (intent) {
    case "MELHORES_OPORTUNIDADES": answer = answerBestOpportunities(ctx, question); break;
    case "PORQUE_CLASSIFICADO": answer = answerWhyClassified(ctx, question); break;
    case "PRECISAM_FOLLOWUP": answer = answerFollowUps(ctx); break;
    case "ANALISE_VENDEDOR": answer = answerAgentAnalysis(ctx, question); break;
    case "OBJECOES_FREQUENTES": answer = answerObjections(ctx); break;
    case "MENSAGEM_FOLLOWUP": answer = answerFollowUpMessage(ctx, question); break;
    case "PROXIMO_PASSO": answer = answerNextStep(ctx, question); break;
    case "CARDS_ETAPA_ERRADA": answer = answerMisplacedCards(ctx); break;
    case "RESUMO_FUNIL": answer = answerFunnelSummary(ctx, question); break;
    case "ONDE_PERDEMOS": answer = answerWhereWeLose(ctx, question); break;
    case "PODEM_RECOMPRAR": answer = answerRepurchase(ctx); break;
    default: answer = answerUnknown(ctx);
  }

  messageSeq += 1;
  return {
    id: `chat_${Date.now().toString(36)}_${messageSeq}`,
    role: "assistant",
    content: answer.content,
    createdAt: new Date().toISOString(),
    citations: answer.citations,
    suggestedActions: answer.suggestedActions,
    insufficientData: answer.insufficientData,
  };
}

/** Perguntas sugeridas exibidas na interface do chat. */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  "Quais sao as melhores oportunidades de hoje?",
  "Quais clientes precisam de follow-up?",
  "Resuma meu funil comercial.",
  "Onde estamos perdendo mais oportunidades?",
  "Quais objecoes estao aparecendo com maior frequencia?",
  "Quais cards parecem estar na etapa errada?",
  "Quais clientes podem comprar novamente?",
] as const;
