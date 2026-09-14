import "server-only";
import type { Tag, TagResolution, TaxonomyTag } from "@/domain/types";

/**
 * Taxonomia curada de etiquetas da Flowi IA.
 *
 * REGRA DO PRODUTO: a IA NAO cria etiquetas livremente. O fluxo e sempre:
 *   1. consultar as etiquetas existentes na conta;
 *   2. reutilizar uma equivalente quando existir (nome exato ou sinonimo);
 *   3. nunca criar uma duplicada;
 *   4. sugerir uma etiqueta nova apenas quando nenhuma servir;
 *   5. pedir aprovacao administrativa para criar;
 *   6. registrar qual regra motivou a aplicacao.
 */

export const TAG_TAXONOMY: readonly TaxonomyTag[] = [
  {
    key: "OPORTUNIDADE_QUENTE",
    name: "IA | Oportunidade quente",
    description: "Intencao de compra clara e recente, com necessidade definida.",
    rule: "Score >= 75 e ultima interacao ha no maximo 7 dias.",
    color: "RED_600",
    synonyms: ["oportunidade quente", "lead quente", "hot lead", "quente"],
  },
  {
    key: "OPORTUNIDADE_DESENVOLVIMENTO",
    name: "IA | Oportunidade em desenvolvimento",
    description: "Interesse identificado, porem ainda sem maturidade comercial.",
    rule: "Score entre 30 e 74.",
    color: "ORANGE_600",
    synonyms: ["oportunidade em desenvolvimento", "lead morno", "em desenvolvimento"],
  },
  {
    key: "FOLLOWUP_NECESSARIO",
    name: "IA | Follow-up necessario",
    description: "Existe um proximo passo combinado que ainda nao foi executado.",
    rule: "Proximo passo identificado na conversa e nao cumprido ate a data prevista.",
    color: "BLUE_600",
    synonyms: ["follow-up", "followup", "follow up", "retornar contato"],
  },
  {
    key: "CLIENTE_SEM_RETORNO",
    name: "IA | Cliente sem retorno",
    description: "O cliente demonstrou interesse e a equipe nao respondeu.",
    rule: "Ultima mensagem e do cliente e ha mais de 24h sem resposta da equipe.",
    color: "YELLOW_600",
    synonyms: ["sem retorno", "aguardando retorno", "nao respondido"],
  },
  {
    key: "PROPOSTA_ENVIADA",
    name: "IA | Proposta enviada",
    description: "Proposta comercial ja enviada, aguardando decisao.",
    rule: "Mensagem de saida contendo proposta ou valor formal identificada.",
    color: "GREEN_600",
    synonyms: ["proposta enviada", "orcamento enviado", "proposta"],
  },
  {
    key: "OBJECAO_PRECO",
    name: "IA | Objecao de preco",
    description: "O cliente sinalizou que o preco e um obstaculo.",
    rule: "Objecao de preco ou pedido de desconto detectado na conversa.",
    color: "PURPLE_600",
    synonyms: ["objecao de preco", "achou caro", "objecao preco"],
  },
  {
    key: "URGENCIA",
    name: "IA | Urgencia",
    description: "O cliente declarou prazo curto para decidir ou receber.",
    rule: "Sinal de urgencia ou prazo de decisao explicito detectado.",
    color: "RED_600",
    synonyms: ["urgente", "urgencia", "prioridade"],
  },
  {
    key: "RECOMPRA",
    name: "IA | Recompra",
    description: "Cliente recorrente em possivel ciclo de nova compra.",
    rule: "Historico de compra anterior somado a sinal de reposicao.",
    color: "GREEN_600",
    synonyms: ["recompra", "recorrente", "cliente recorrente", "reposicao"],
  },
  {
    key: "SEM_PERFIL",
    name: "IA | Sem perfil",
    description: "Contato fora do perfil comercial atendido.",
    rule: "Sinal de fora de perfil detectado e nenhum sinal de compra.",
    color: "GRAY_600",
    synonyms: ["sem perfil", "fora do perfil", "nao qualificado"],
  },
  {
    key: "ATENDIMENTO_SUPORTE",
    name: "IA | Atendimento de suporte",
    description: "Conversa exclusivamente de suporte, sem oportunidade comercial.",
    rule: "Sinais de suporte presentes e nenhum sinal de compra.",
    color: "GRAY_600",
    synonyms: ["suporte", "atendimento de suporte", "tecnico"],
  },
  {
    key: "DADOS_INCOMPLETOS",
    name: "IA | Dados incompletos",
    description: "Faltam dados cadastrais para trabalhar a oportunidade.",
    rule: "Confianca da analise abaixo de 40 por ausencia de dados do contato.",
    color: "GRAY_600",
    synonyms: ["dados incompletos", "cadastro incompleto", "sem dados"],
  },
] as const;

export function findTaxonomyTag(key: string): TaxonomyTag | undefined {
  return TAG_TAXONOMY.find((t) => t.key === key);
}

/** Normaliza para comparacao: minusculas, sem acento e sem pontuacao. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve uma etiqueta da taxonomia contra as etiquetas existentes na conta.
 *
 * Nunca devolve "criar": no maximo devolve NEEDS_APPROVAL, e quem decide
 * criar e um administrador, pela tela de configuracoes.
 */
export function resolveTag(key: string, existingTags: Tag[]): TagResolution | null {
  const taxonomy = findTaxonomyTag(key);
  if (!taxonomy) return null;

  const canonicalNormalized = normalize(taxonomy.name);

  // 1. Correspondencia exata pelo nome canonico.
  const exact = existingTags.find((t) => normalize(t.name) === canonicalNormalized);
  if (exact) {
    return {
      key,
      canonicalName: taxonomy.name,
      matched: exact,
      outcome: "REUSE_EXACT",
      rule: taxonomy.rule,
    };
  }

  // 2. Correspondencia por sinonimo — evita criar duplicada de algo que a
  //    equipe ja mantem com outro nome.
  const synonymsNormalized = taxonomy.synonyms.map(normalize);
  const bySynonym = existingTags.find((t) => {
    const tagName = normalize(t.name);
    return synonymsNormalized.some(
      (syn) => tagName === syn || tagName.includes(syn) || syn.includes(tagName),
    );
  });

  if (bySynonym) {
    return {
      key,
      canonicalName: taxonomy.name,
      matched: bySynonym,
      outcome: "REUSE_SYNONYM",
      rule: taxonomy.rule,
    };
  }

  // 3. Nenhuma equivalente: precisa de aprovacao administrativa.
  return {
    key,
    canonicalName: taxonomy.name,
    outcome: "NEEDS_APPROVAL",
    rule: taxonomy.rule,
  };
}

export function resolveTags(keys: string[], existingTags: Tag[]): TagResolution[] {
  const seen = new Set<string>();
  const out: TagResolution[] = [];

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);

    const resolution = resolveTag(key, existingTags);
    if (!resolution) continue;

    // Evita aplicar duas chaves diferentes que caiam na MESMA etiqueta.
    if (resolution.matched && out.some((r) => r.matched?.id === resolution.matched?.id)) {
      continue;
    }
    out.push(resolution);
  }
  return out;
}

/**
 * Decide quais chaves da taxonomia se aplicam a uma oportunidade.
 * Cada regra e explicita e auditavel.
 */
export function recommendTagKeys(params: {
  score: number;
  confidence: number;
  hoursWithoutReply: number;
  signalCodes: string[];
  hasOpenCard: boolean;
  lastMessageFromContact: boolean;
}): string[] {
  const keys: string[] = [];
  const has = (code: string) => params.signalCodes.includes(code);

  const isSupportOnly =
    has("SUPORTE_APENAS") &&
    !["SOLICITACAO_PRECO", "NECESSIDADE_EXPLICITA", "CONDICOES_PAGAMENTO", "PEDIDO_DESCONTO"]
      .some(has);

  if (isSupportOnly) {
    keys.push("ATENDIMENTO_SUPORTE");
    return keys;
  }

  if (has("FORA_PERFIL")) {
    keys.push("SEM_PERFIL");
    return keys;
  }

  if (params.score >= 75 && params.hoursWithoutReply <= 24 * 7) {
    keys.push("OPORTUNIDADE_QUENTE");
  } else if (params.score >= 30) {
    keys.push("OPORTUNIDADE_DESENVOLVIMENTO");
  }

  if (params.lastMessageFromContact && params.hoursWithoutReply >= 24) {
    keys.push("CLIENTE_SEM_RETORNO");
  }

  if (params.hoursWithoutReply >= 48 && params.score >= 50) {
    keys.push("FOLLOWUP_NECESSARIO");
  }

  if (has("PROPOSTA_ENVIADA")) keys.push("PROPOSTA_ENVIADA");
  if (has("PEDIDO_DESCONTO")) keys.push("OBJECAO_PRECO");
  if (has("URGENCIA") || has("PRAZO_DECISAO")) keys.push("URGENCIA");
  if (has("RECOMPRA")) keys.push("RECOMPRA");
  if (params.confidence < 40) keys.push("DADOS_INCOMPLETOS");

  return keys;
}
