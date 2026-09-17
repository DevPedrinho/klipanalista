import type { Priority } from "@/domain/enums";
import {
  SCORE_WEIGHTS,
  type ConversationSnapshot,
  type CrmCard,
  type DetectedSignal,
  type ScoreBreakdown,
  type ScoreResult,
} from "@/domain/types";
import { detectSignals } from "./signals";

/**
 * Motor de score de oportunidade.
 *
 * Duas medidas independentes, conforme definido no produto:
 *  - SCORE      -> quanto esta oportunidade vale a atencao do time (0-100).
 *  - CONFIANCA  -> quanta evidencia sustenta essa leitura (0-100).
 *
 * Um caso pode ter score alto e confianca baixa (poucos dados, sinal forte)
 * ou score medio e confianca alta (muita conversa, interesse morno).
 */

/** Corte abaixo do qual a oportunidade nao e exibida como principal. */
export const SCORE_DISPLAY_THRESHOLD = 30;

/** Sinais que, sozinhos, nunca sustentam uma oportunidade. */
const WEAK_ALONE = new Set(["DISPONIBILIDADE", "COMPARACAO_PRODUTOS", "PRAZO_ENTREGA"]);

/** Sinais negativos que desqualificam a oportunidade por completo. */
const HARD_DISQUALIFIERS = new Set([
  "DESCADASTRO",
  "SPAM",
  "COMPRA_CONCLUIDA",
]);

export interface ScoreInput {
  conversation: ConversationSnapshot;
  /** Card ja existente para este contato, se houver. */
  existingCard?: CrmCard;
  /** Numero de conversas anteriores do mesmo contato. */
  previousConversationCount: number;
  /**
   * Sinais ja detectados, quando houver.
   *
   * Existe para que a leitura por IA entre no MESMO motor de pontuacao: o
   * modelo encontra os sinais, com trecho literal verificado, e os pesos,
   * cortes e regras de contexto daqui continuam decidindo o score. Assim a
   * analise fica melhor sem ficar inauditavel.
   *
   * Omitido, o motor detecta sozinho como sempre fez.
   */
  signals?: DetectedSignal[];
  /** Momento de referencia para calcular recencia. Default: agora. */
  now?: Date;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hoursBetween(from: string, to: Date): number {
  const diff = to.getTime() - new Date(from).getTime();
  return Math.max(0, diff / 36e5);
}

/* --------------------------------------------------------------------------
   Dimensao 1 — Intencao explicita de compra (ate 30 pontos)
   -------------------------------------------------------------------------- */
const INTENT_SIGNALS: Record<string, number> = {
  NECESSIDADE_EXPLICITA: 1,
  ORCAMENTO_APROVADO: 1,
  SOLICITACAO_PRECO: 0.85,
  PEDIDO_DESCONTO: 0.8,
  CONDICOES_PAGAMENTO: 0.75,
  PEDIDO_VENDEDOR: 0.7,
  ENVIOU_ESPECIFICACAO: 0.65,
  PROPOSTA_ENVIADA: 0.7,
  RECOMPRA: 0.6,
  INSATISFEITO_FORNECEDOR: 0.55,
  DISPONIBILIDADE: 0.4,
  PRAZO_ENTREGA: 0.4,
  COMPARACAO_PRODUTOS: 0.35,
};

function scoreIntent(signals: DetectedSignal[]): number {
  const positives = signals.filter((s) => s.polarity === "POSITIVE");
  if (positives.length === 0) return 0;

  // A intencao e dominada pelo sinal mais forte; sinais adicionais reforcam
  // com retorno decrescente, para nao somar linearmente evidencias repetidas.
  const contributions = positives
    .map((s) => (INTENT_SIGNALS[s.code] ?? 0.3) * s.strength)
    .sort((a, b) => b - a);

  const primary = contributions[0] ?? 0;
  const reinforcement = contributions
    .slice(1)
    .reduce((acc, value, index) => acc + value / (index + 2), 0);

  const normalized = clamp(primary + reinforcement * 0.35, 0, 1);
  return normalized * SCORE_WEIGHTS.intencaoExplicita;
}

/* --------------------------------------------------------------------------
   Dimensao 2 — Recencia da interacao (ate 15 pontos)
   -------------------------------------------------------------------------- */
function scoreRecency(lastMessageAt: string, now: Date): number {
  const hours = hoursBetween(lastMessageAt, now);
  const days = hours / 24;

  // Quente ate 2 dias, decai ate zerar aos 45 dias.
  let factor: number;
  if (days <= 2) factor = 1;
  else if (days <= 7) factor = 0.85;
  else if (days <= 15) factor = 0.6;
  else if (days <= 30) factor = 0.35;
  else if (days <= 45) factor = 0.15;
  else factor = 0;

  return factor * SCORE_WEIGHTS.recencia;
}

/* --------------------------------------------------------------------------
   Dimensao 3 — Clareza da necessidade (ate 15 pontos)
   -------------------------------------------------------------------------- */
function scoreClarity(conversation: ConversationSnapshot, signals: DetectedSignal[]): number {
  const inbound = conversation.messages.filter((m) => m.direction === "INBOUND");
  if (inbound.length === 0) return 0;

  const totalWords = inbound.reduce(
    (acc, m) => acc + m.text.trim().split(/\s+/).length,
    0,
  );

  // Volume de texto do cliente indica o quanto ele detalhou a necessidade.
  let volumeFactor: number;
  if (totalWords >= 120) volumeFactor = 1;
  else if (totalWords >= 60) volumeFactor = 0.8;
  else if (totalWords >= 25) volumeFactor = 0.55;
  else if (totalWords >= 10) volumeFactor = 0.3;
  else volumeFactor = 0.15;

  // Especificacao enviada ou produto nomeado eleva bastante a clareza.
  const hasSpec = signals.some((s) => s.code === "ENVIOU_ESPECIFICACAO");
  const hasComparison = signals.some((s) => s.code === "COMPARACAO_PRODUTOS");
  const specBonus = hasSpec ? 0.25 : hasComparison ? 0.1 : 0;

  return clamp(volumeFactor + specBonus, 0, 1) * SCORE_WEIGHTS.clarezaNecessidade;
}

/* --------------------------------------------------------------------------
   Dimensao 4 — Maturidade comercial (ate 15 pontos)
   -------------------------------------------------------------------------- */
function scoreMaturity(signals: DetectedSignal[], existingCard?: CrmCard): number {
  let factor = 0;

  // Estagios progressivos do processo de compra.
  if (signals.some((s) => s.code === "DISPONIBILIDADE")) factor = Math.max(factor, 0.25);
  if (signals.some((s) => s.code === "SOLICITACAO_PRECO")) factor = Math.max(factor, 0.5);
  if (signals.some((s) => s.code === "CONDICOES_PAGAMENTO")) factor = Math.max(factor, 0.7);
  if (signals.some((s) => s.code === "PROPOSTA_ENVIADA")) factor = Math.max(factor, 0.75);
  if (signals.some((s) => s.code === "PEDIDO_DESCONTO")) factor = Math.max(factor, 0.8);
  if (signals.some((s) => s.code === "PRAZO_DECISAO")) factor = Math.max(factor, 0.85);
  if (signals.some((s) => s.code === "ORCAMENTO_APROVADO")) factor = Math.max(factor, 1);

  // Um card ja aberto e evidencia de processo em andamento.
  if (existingCard && existingCard.status === "OPEN") factor = Math.max(factor, 0.6);

  return factor * SCORE_WEIGHTS.maturidadeComercial;
}

/* --------------------------------------------------------------------------
   Dimensao 5 — Existencia de proximo passo (ate 10 pontos)
   -------------------------------------------------------------------------- */
const NEXT_STEP_PATTERNS = [
  /\b(agend(ar|amos|ado)|marcar|remarcar)\s+(?:uma\s+|um\s+)?(reuni[ãa]o|visita|call|liga[çc][ãa]o|demonstra[çc][ãa]o)\b/i,
  /\b(te\s+)?(envio|mando|retorno|confirmo)\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|at[ée])\b/i,
  /\b(fico\s+no\s+aguardo|aguardo\s+(seu\s+)?retorno)\b/i,
  /\bvou\s+(analisar|verificar|levar)\s+(?:[\wçãõáéíóúâêô]+\s+){0,4}?e\s+(te\s+)?(retorno|falo|aviso)\b/i,
];

function scoreNextStep(conversation: ConversationSnapshot, signals: DetectedSignal[]): number {
  const hasAgreedStep = conversation.messages.some((m) =>
    NEXT_STEP_PATTERNS.some((re) => re.test(m.text)),
  );
  const hasDeadline = signals.some((s) => s.code === "PRAZO_DECISAO");
  const askedForAgent = signals.some((s) => s.code === "PEDIDO_VENDEDOR");

  let factor = 0;
  if (hasAgreedStep) factor += 0.6;
  if (hasDeadline) factor += 0.3;
  if (askedForAgent) factor += 0.25;

  return clamp(factor, 0, 1) * SCORE_WEIGHTS.proximoPasso;
}

/* --------------------------------------------------------------------------
   Dimensao 6 — Relacionamento ou recorrencia (ate 10 pontos)
   -------------------------------------------------------------------------- */
function scoreRelationship(
  previousConversationCount: number,
  signals: DetectedSignal[],
): number {
  let factor = 0;

  if (previousConversationCount >= 5) factor = 0.8;
  else if (previousConversationCount >= 2) factor = 0.55;
  else if (previousConversationCount === 1) factor = 0.3;

  if (signals.some((s) => s.code === "RECOMPRA")) factor = Math.max(factor, 0.9);

  return clamp(factor, 0, 1) * SCORE_WEIGHTS.relacionamento;
}

/* --------------------------------------------------------------------------
   Dimensao 7 — Qualidade dos dados disponiveis (ate 5 pontos)
   -------------------------------------------------------------------------- */
export interface DataQualityInput {
  hasName: boolean;
  hasPhone: boolean;
  hasCompany: boolean;
  hasEmail: boolean;
  hasAgent: boolean;
}

function scoreDataQuality(input: DataQualityInput): number {
  const checks = [
    input.hasName,
    input.hasPhone,
    input.hasCompany,
    input.hasEmail,
    input.hasAgent,
  ];
  const filled = checks.filter(Boolean).length;
  return (filled / checks.length) * SCORE_WEIGHTS.qualidadeDados;
}

/* --------------------------------------------------------------------------
   Confianca — quantidade e qualidade das evidencias
   -------------------------------------------------------------------------- */
function computeConfidence(
  signals: DetectedSignal[],
  conversation: ConversationSnapshot,
  dataQuality: DataQualityInput,
): number {
  const positives = signals.filter((s) => s.polarity === "POSITIVE");
  const inboundCount = conversation.messages.filter((m) => m.direction === "INBOUND").length;

  // 1. Quantidade de sinais distintos encontrados.
  const breadth = clamp(positives.length / 4, 0, 1);

  // 2. Forca media dos sinais (trechos com contexto valem mais).
  const avgStrength =
    positives.length > 0
      ? positives.reduce((acc, s) => acc + s.strength, 0) / positives.length
      : 0;

  // 3. Volume de conversa: uma unica mensagem sustenta pouco.
  const volume = clamp(inboundCount / 6, 0, 1);

  // 4. Completude cadastral.
  const dataChecks = Object.values(dataQuality).filter(Boolean).length;
  const completeness = dataChecks / 5;

  const confidence =
    breadth * 35 + avgStrength * 30 + volume * 20 + completeness * 15;

  return Math.round(clamp(confidence, 0, 100));
}

/* --------------------------------------------------------------------------
   Classificacao
   -------------------------------------------------------------------------- */
export function classifyPriority(score: number, hoursWithoutReply: number): Priority {
  if (score >= 75) {
    // Alta prioridade que ja passou de 48h sem retorno vira urgencia critica.
    return hoursWithoutReply >= 48 ? "CRITICA" : "ALTA";
  }
  if (score >= 50) return "MEDIA";
  return "BAIXA";
}

/** Rotulo legivel da faixa de score, conforme a regra do produto. */
export function scoreBandLabel(score: number): string {
  if (score >= 75) return "Alta prioridade";
  if (score >= 50) return "Media prioridade";
  if (score >= SCORE_DISPLAY_THRESHOLD) return "Oportunidade em desenvolvimento";
  return "Abaixo do corte de exibicao";
}

/* --------------------------------------------------------------------------
   Calculo principal
   -------------------------------------------------------------------------- */
export function computeScore(input: ScoreInput, dataQuality: DataQualityInput): ScoreResult {
  const now = input.now ?? new Date();
  const { conversation, existingCard, previousConversationCount } = input;

  const signals = input.signals ?? detectSignals(conversation.messages);
  const positives = signals.filter((s) => s.polarity === "POSITIVE");
  const disqualifiers = signals.filter((s) => s.polarity === "NEGATIVE");

  const rationale: string[] = [];

  const breakdown: ScoreBreakdown = {
    intencaoExplicita: scoreIntent(signals),
    recencia: scoreRecency(conversation.lastMessageAt, now),
    clarezaNecessidade: scoreClarity(conversation, signals),
    maturidadeComercial: scoreMaturity(signals, existingCard),
    proximoPasso: scoreNextStep(conversation, signals),
    relacionamento: scoreRelationship(previousConversationCount, signals),
    qualidadeDados: scoreDataQuality(dataQuality),
  };

  let raw = Object.values(breakdown).reduce((acc, value) => acc + value, 0);

  /* --- Regra de contexto: nunca classificar por palavras isoladas --------- */
  const onlyWeakSignals =
    positives.length > 0 && positives.every((s) => WEAK_ALONE.has(s.code));
  const singleShortSignal = positives.length === 1 && (positives[0]?.strength ?? 0) < 0.6;

  if (onlyWeakSignals) {
    raw *= 0.55;
    rationale.push(
      "Apenas sinais fracos e isolados foram encontrados (consulta generica). " +
        "O score foi reduzido para evitar classificacao por palavra solta.",
    );
  } else if (singleShortSignal) {
    raw *= 0.7;
    rationale.push(
      "Um unico sinal, em mensagem curta e sem contexto. O score foi reduzido " +
        "ate que a conversa traga mais elementos.",
    );
  }

  /* --- Penalidades e desqualificacoes por sinais negativos ---------------- */
  const hardHit = disqualifiers.find((s) => HARD_DISQUALIFIERS.has(s.code));
  if (hardHit) {
    raw = 0;
    rationale.push(
      `Desqualificada: ${hardHit.label.toLowerCase()}. Evidencia: "${hardHit.excerpt}".`,
    );
  } else if (disqualifiers.length > 0) {
    const penalty = disqualifiers.reduce((acc, s) => acc + s.strength * 0.2, 0);
    raw *= clamp(1 - penalty, 0.3, 1);
    rationale.push(
      `Sinais de nao-oportunidade reduziram o score: ${disqualifiers
        .map((s) => s.label.toLowerCase())
        .join(", ")}.`,
    );
  }

  /* --- Oportunidade ja registrada no CRM ---------------------------------- */
  if (existingCard && existingCard.status === "OPEN") {
    rationale.push(
      "Ja existe card aberto no CRM para este contato. A sugestao sera de " +
        "atualizacao, nao de criacao, para evitar duplicidade.",
    );
  }

  const score = Math.round(clamp(raw, 0, 100));
  const hoursWithoutReply = Math.floor(hoursBetween(conversation.lastMessageAt, now));
  const confidence = computeConfidence(signals, conversation, dataQuality);
  const priority = classifyPriority(score, hoursWithoutReply);

  /* --- Explicacoes principais --------------------------------------------- */
  if (positives.length > 0 && !hardHit) {
    const top = positives.slice(0, 3).map((s) => s.label.toLowerCase());
    rationale.unshift(`Sinais de compra identificados: ${top.join(", ")}.`);
  }

  if (breakdown.recencia === 0) {
    rationale.push(
      "Ultima interacao ha mais de 45 dias: a recencia nao contribuiu com pontos.",
    );
  }

  if (confidence < 40) {
    rationale.push(
      "Confianca baixa: ha poucos dados na conversa. Trate como hipotese a " +
        "confirmar, nao como conclusao.",
    );
  }

  return {
    score,
    breakdown,
    confidence,
    priority,
    belowThreshold: score < SCORE_DISPLAY_THRESHOLD,
    signals: positives,
    rationale,
    disqualifiers,
  };
}
