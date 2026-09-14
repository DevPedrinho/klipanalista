import "server-only";
import type {
  AgentQualityReport,
  ConversationSnapshot,
  CrmCard,
  QualityCriterion,
} from "@/domain/types";
import { detectObjections, detectSignals } from "@/server/scoring/signals";

/**
 * Analise da qualidade do atendimento.
 *
 * POSTURA DO PRODUTO: isto NAO e vigilancia punitiva. Cada criterio vem
 * acompanhado de uma observacao orientativa, e o relatorio sempre destaca
 * pontos fortes antes das areas de desenvolvimento. O objetivo e desenvolver
 * a equipe e aumentar a conversao, nao produzir ranking de culpados.
 */

/** Minutos entre a primeira mensagem do cliente e a primeira resposta. */
function firstResponseMinutes(conversation: ConversationSnapshot): number | null {
  const firstInbound = conversation.messages.find((m) => m.direction === "INBOUND");
  if (!firstInbound) return null;

  const firstReply = conversation.messages.find(
    (m) => m.direction === "OUTBOUND" && m.sentAt > firstInbound.sentAt,
  );
  if (!firstReply) return null;

  return Math.max(
    0,
    (Date.parse(firstReply.sentAt) - Date.parse(firstInbound.sentAt)) / 60000,
  );
}

/** Media dos tempos de resposta da equipe ao longo da conversa. */
function averageResponseMinutes(conversation: ConversationSnapshot): number | null {
  const gaps: number[] = [];

  for (let i = 0; i < conversation.messages.length - 1; i += 1) {
    const current = conversation.messages[i];
    const next = conversation.messages[i + 1];
    if (!current || !next) continue;

    if (current.direction === "INBOUND" && next.direction === "OUTBOUND") {
      gaps.push((Date.parse(next.sentAt) - Date.parse(current.sentAt)) / 60000);
    }
  }

  if (gaps.length === 0) return null;
  return gaps.reduce((acc, value) => acc + value, 0) / gaps.length;
}

/** Perguntas feitas pela equipe — proxy de esforco de qualificacao. */
function qualificationQuestions(conversation: ConversationSnapshot): number {
  return conversation.messages.filter(
    (m) => m.direction === "OUTBOUND" && m.text.includes("?"),
  ).length;
}

const BUDGET_PATTERNS = [/\bor[çc]amento\b/i, /\bfaixa\s+de\s+(valor|investimento)\b/i, /\bquanto\s+voc[êe]s?\s+pretend/i];
const TIMING_PATTERNS = [/\bpara\s+quando\b/i, /\bprazo\b/i, /\bat[ée]\s+quando\b/i, /\bqual\s+a\s+urg[êe]ncia\b/i];
const NEXT_STEP_PATTERNS = [/\bagend/i, /\bte\s+(retorno|envio|ligo)\b/i, /\bfico\s+no\s+aguardo\b/i, /\bconfirmo\s+(at[ée]|amanh[ãa])\b/i];

function matchedInOutbound(conversation: ConversationSnapshot, patterns: RegExp[]): boolean {
  return conversation.messages.some(
    (m) => m.direction === "OUTBOUND" && patterns.some((re) => re.test(m.text)),
  );
}

function bandStatus(score: number): QualityCriterion["status"] {
  if (score >= 70) return "BOM";
  if (score >= 40) return "ATENCAO";
  return "CRITICO";
}

function criterion(
  key: string,
  label: string,
  score: number,
  noteGood: string,
  noteBad: string,
): QualityCriterion {
  return {
    key,
    label,
    score,
    status: bandStatus(score),
    note: score >= 70 ? noteGood : noteBad,
  };
}

export interface QualityInput {
  agentId: string;
  agentName: string;
  teamName?: string;
  conversations: ConversationSnapshot[];
  cards: CrmCard[];
  /** Ids de sessao que a IA identificou como oportunidade. */
  opportunitySessionIds: Set<string>;
}

export function buildQualityReport(input: QualityInput): AgentQualityReport {
  const { conversations } = input;

  /* --- Tempos de resposta ------------------------------------------------ */
  const firstResponses = conversations
    .map(firstResponseMinutes)
    .filter((v): v is number => v !== null);
  const avgResponses = conversations
    .map(averageResponseMinutes)
    .filter((v): v is number => v !== null);

  const firstResponseAvg =
    firstResponses.length > 0
      ? firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length
      : 0;
  const responseAvg =
    avgResponses.length > 0 ? avgResponses.reduce((a, b) => a + b, 0) / avgResponses.length : 0;

  // 15 min ou menos = excelente; acima de 4h = critico.
  const firstResponseScore =
    firstResponses.length === 0 ? 0 : Math.round(Math.max(0, Math.min(100, 100 - (firstResponseAvg / 240) * 100)));
  const avgResponseScore =
    avgResponses.length === 0 ? 0 : Math.round(Math.max(0, Math.min(100, 100 - (responseAvg / 240) * 100)));

  /* --- Qualificacao ------------------------------------------------------ */
  const totalQuestions = conversations.reduce((acc, c) => acc + qualificationQuestions(c), 0);
  const questionsPerConversation =
    conversations.length > 0 ? totalQuestions / conversations.length : 0;
  const qualificationScore = Math.round(Math.min(100, (questionsPerConversation / 3) * 100));

  const withBudget = conversations.filter((c) => matchedInOutbound(c, BUDGET_PATTERNS)).length;
  const withTiming = conversations.filter((c) => matchedInOutbound(c, TIMING_PATTERNS)).length;
  const withNextStep = conversations.filter((c) => matchedInOutbound(c, NEXT_STEP_PATTERNS)).length;

  const pct = (n: number) => (conversations.length > 0 ? Math.round((n / conversations.length) * 100) : 0);

  /* --- Necessidade e objecoes -------------------------------------------- */
  const withNeed = conversations.filter((c) => {
    const signals = detectSignals(c.messages);
    return signals.some((s) => s.polarity === "POSITIVE");
  }).length;

  const withObjections = conversations.filter((c) => detectObjections(c.messages).length > 0).length;

  /* --- Conversas abandonadas --------------------------------------------- */
  const abandoned = conversations.filter((c) => {
    const last = c.messages[c.messages.length - 1];
    if (!last || last.direction !== "INBOUND") return false;
    return Date.now() - Date.parse(last.sentAt) > 48 * 36e5;
  }).length;
  const abandonedScore = Math.round(
    conversations.length > 0 ? Math.max(0, 100 - (abandoned / conversations.length) * 100) : 100,
  );

  /* --- Oportunidade nao registrada no CRM -------------------------------- */
  const unregistered = [...input.opportunitySessionIds].filter(
    (sessionId) => !input.cards.some((card) => card.sessionId === sessionId),
  ).length;
  const registrationScore = Math.round(
    input.opportunitySessionIds.size > 0
      ? Math.max(0, 100 - (unregistered / input.opportunitySessionIds.size) * 100)
      : 100,
  );

  /* --- Cards desatualizados ---------------------------------------------- */
  const staleCards = input.cards.filter(
    (c) => c.status === "OPEN" && Date.now() - Date.parse(c.updatedAt) > 14 * 24 * 36e5,
  ).length;
  const freshnessScore = Math.round(
    input.cards.length > 0 ? Math.max(0, 100 - (staleCards / input.cards.length) * 100) : 100,
  );

  const criteria: QualityCriterion[] = [
    criterion(
      "primeira_resposta",
      "Tempo para primeira resposta",
      firstResponseScore,
      `Media de ${Math.round(firstResponseAvg)} min. Ritmo muito bom: a resposta rapida e o maior preditor de conversao.`,
      firstResponses.length === 0
        ? "Nao houve resposta da equipe nas conversas analisadas neste periodo."
        : `Media de ${Math.round(firstResponseAvg)} min. Responder na primeira hora aumenta bastante a chance de avancar.`,
    ),
    criterion(
      "tempo_medio",
      "Tempo medio de resposta",
      avgResponseScore,
      `Media de ${Math.round(responseAvg)} min ao longo da conversa. Cadencia consistente.`,
      `Media de ${Math.round(responseAvg)} min. Vale combinar um tempo-alvo de retorno com o cliente.`,
    ),
    criterion(
      "qualificacao",
      "Perguntas de qualificacao",
      qualificationScore,
      `${questionsPerConversation.toFixed(1)} pergunta(s) por atendimento. Boa investigacao.`,
      `${questionsPerConversation.toFixed(1)} pergunta(s) por atendimento. Duas ou tres perguntas abertas ajudam a entender o cenario real.`,
    ),
    criterion(
      "necessidade",
      "Necessidade identificada",
      pct(withNeed),
      `Necessidade identificada em ${pct(withNeed)}% dos atendimentos.`,
      `Necessidade clara em ${pct(withNeed)}% dos atendimentos. Confirmar o problema do cliente antes de falar de preco costuma render mais.`,
    ),
    criterion(
      "orcamento",
      "Orcamento identificado",
      pct(withBudget),
      `Tema de investimento abordado em ${pct(withBudget)}% dos atendimentos.`,
      `Orcamento abordado em apenas ${pct(withBudget)}%. Perguntar a faixa de investimento cedo evita proposta fora do alvo.`,
    ),
    criterion(
      "prazo",
      "Prazo de compra identificado",
      pct(withTiming),
      `Prazo do cliente mapeado em ${pct(withTiming)}% dos atendimentos.`,
      `Prazo mapeado em ${pct(withTiming)}%. Saber a data-alvo do cliente ajuda a priorizar o funil.`,
    ),
    criterion(
      "objecoes",
      "Objecoes identificadas",
      pct(withObjections),
      `Objecoes trazidas a tona em ${pct(withObjections)}% dos casos: sinal de conversa franca.`,
      `Poucas objecoes registradas (${pct(withObjections)}%). Perguntar "o que te impediria de fechar hoje?" costuma revelar o real obstaculo.`,
    ),
    criterion(
      "proximo_passo",
      "Proximo passo combinado",
      pct(withNextStep),
      `Proximo passo combinado em ${pct(withNextStep)}% dos atendimentos.`,
      `Proximo passo explicito em ${pct(withNextStep)}%. Encerrar toda conversa com data e acao definidas reduz muito o esquecimento.`,
    ),
    criterion(
      "continuidade",
      "Conversas sem abandono",
      abandonedScore,
      "Nenhuma conversa relevante ficou sem retorno.",
      `${abandoned} conversa(s) com o cliente aguardando ha mais de 48h.`,
    ),
    criterion(
      "registro_crm",
      "Oportunidade registrada no CRM",
      registrationScore,
      "Todas as oportunidades identificadas estao no funil.",
      `${unregistered} oportunidade(s) identificada(s) ainda sem card no CRM.`,
    ),
    criterion(
      "card_atualizado",
      "Cards atualizados",
      freshnessScore,
      "Cards com movimentacao recente.",
      `${staleCards} card(s) aberto(s) sem atualizacao ha mais de 14 dias.`,
    ),
  ];

  const overallScore = Math.round(
    criteria.reduce((acc, c) => acc + c.score, 0) / Math.max(1, criteria.length),
  );

  const strengths = criteria
    .filter((c) => c.status === "BOM")
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.label);

  const developmentAreas = criteria
    .filter((c) => c.status !== "BOM")
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => c.label);

  const focus = developmentAreas[0];
  const coachingSuggestion = focus
    ? `Sugestao de foco para a proxima semana: ${focus.toLowerCase()}. ` +
      `Escolha dois atendimentos em andamento e aplique a mudanca neles antes de generalizar.`
    : "Desempenho consistente nos criterios analisados. Vale registrar o que esta funcionando e compartilhar com a equipe.";

  return {
    agentId: input.agentId,
    agentName: input.agentName,
    teamName: input.teamName,
    conversationsAnalyzed: conversations.length,
    firstResponseTimeMinutes: Math.round(firstResponseAvg),
    averageResponseTimeMinutes: Math.round(responseAvg),
    overallScore,
    criteria,
    strengths,
    developmentAreas,
    coachingSuggestion,
  };
}
