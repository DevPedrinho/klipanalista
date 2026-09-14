import type { DetectedSignal, MessageSnapshot, SignalPolarity } from "@/domain/types";

/**
 * Deteccao de sinais comerciais em conversas reais.
 *
 * Principio do produto: NUNCA classificar um cliente como oportunidade por
 * palavras isoladas. Cada regra exige um padrao com contexto, e sinais fracos
 * sozinhos nao sustentam uma oportunidade — ver `score.ts`.
 */

interface SignalRule {
  code: string;
  label: string;
  polarity: SignalPolarity;
  /** Peso relativo do sinal quando disparado com forca maxima. */
  weight: number;
  /** Padroes que exigem contexto, nao apenas a presenca de um termo. */
  patterns: RegExp[];
  /**
   * Se algum destes padroes aparecer na mesma mensagem, o sinal e descartado.
   * Evita falsos positivos como "nao quero orcamento" ou "ja comprei".
   */
  negatedBy?: RegExp[];
  /** Apenas mensagens nesta direcao podem disparar a regra. */
  direction?: "INBOUND" | "OUTBOUND";
}

/* --------------------------------------------------------------------------
   Negacoes genericas: invalidam a leitura positiva de um trecho.
   -------------------------------------------------------------------------- */
const GENERIC_NEGATIONS = [
  /\bn[ãa]o\s+(quero|preciso|tenho\s+interesse|pretendo|vou)\b/i,
  /\bsem\s+interesse\b/i,
  /\bdeixa\s+pra\s+l[áa]\b/i,
  /\bj[áa]\s+(comprei|resolvi|fechei|contratei)\b/i,
  /\bapenas\s+(pesquisando|curiosidade)\b/i,
];

/* --------------------------------------------------------------------------
   SINAIS POSITIVOS
   -------------------------------------------------------------------------- */
const POSITIVE_RULES: SignalRule[] = [
  {
    code: "SOLICITACAO_PRECO",
    label: "Solicitacao de preco ou orcamento",
    polarity: "POSITIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(qual|quanto)\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(custa|fica|sai|[ée]\s+o\s+valor|o\s+pre[çc]o)\b/i,
      /\b(me\s+)?(passa|envia|manda|gostaria\s+de|queria|preciso\s+de)\s+(?:um\s+|uma\s+)?(or[çc]amento|cota[çc][ãa]o|proposta)\b/i,
      /\bvalor\s+(do|da|dos|das)\s+\w+/i,
      /\btabela\s+de\s+pre[çc]os?\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "DISPONIBILIDADE",
    label: "Pergunta sobre disponibilidade",
    polarity: "POSITIVE",
    weight: 0.8,
    direction: "INBOUND",
    patterns: [
      /\b(tem|teria|possui|h[áa])\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(dispon[íi]vel|em\s+estoque|pronta\s+entrega)\b/i,
      /\bvoc[êe]s?\s+(trabalham|tem|vendem)\s+com\b/i,
      /\bainda\s+t[êe]m\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "PRAZO_ENTREGA",
    label: "Pergunta sobre entrega, prazo ou instalacao",
    polarity: "POSITIVE",
    weight: 0.8,
    direction: "INBOUND",
    patterns: [
      /\b(prazo|tempo)\s+de\s+(entrega|instala[çc][ãa]o|execu[çc][ãa]o)\b/i,
      /\bem\s+quanto\s+tempo\s+(chega|entrega|fica\s+pronto)\b/i,
      /\bvoc[êe]s?\s+(entregam|instalam)\s+em\b/i,
      /\bfrete\s+(para|pra|at[ée])\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "CONDICOES_PAGAMENTO",
    label: "Interesse em condicoes de pagamento",
    polarity: "POSITIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(parcela|parcelamento|parcelar)\b/i,
      /\bforma(s)?\s+de\s+pagamento\b/i,
      /\b(aceita|aceitam)\s+(cart[ãa]o|pix|boleto|faturamento)\b/i,
      /\bem\s+quantas\s+vezes\b/i,
      /\bprazo\s+de\s+pagamento\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "COMPARACAO_PRODUTOS",
    label: "Comparacao entre produtos",
    polarity: "POSITIVE",
    weight: 0.7,
    direction: "INBOUND",
    patterns: [
      /\bdiferen[çc]a\s+entre\b/i,
      /\bqual\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(melhor|mais\s+indicad[oa]|vale\s+mais)\b/i,
      /\bcompar(ar|ando|a[çc][ãa]o)\b/i,
      /\bvers[ãa]o\s+\w+\s+ou\s+\w+/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "PEDIDO_DESCONTO",
    label: "Pedido de desconto",
    polarity: "POSITIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(desconto|abatimento|condi[çc][ãa]o\s+especial)\b/i,
      /\b(consegue|tem\s+como|d[áa]\s+pra)\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(melhorar|baixar|reduzir)\s+(?:o\s+)?(pre[çc]o|valor)\b/i,
      /\b[úu]ltimo\s+pre[çc]o\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "NECESSIDADE_EXPLICITA",
    label: "Necessidade explicita de compra",
    polarity: "POSITIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(preciso|necessito|quero|gostaria\s+de)\s+(comprar|adquirir|contratar|fechar)\b/i,
      /\bestou\s+(precisando|procurando|buscando)\b/i,
      /\bquero\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(or[çc]amento|fechar|contratar)\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "PRAZO_DECISAO",
    label: "Prazo definido para decidir",
    polarity: "POSITIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\bpreciso\s+(?:disso\s+|dele\s+|dela\s+)?(at[ée]|para|pra)\s+\w+/i,
      /\bat[ée]\s+(o\s+fim|final)\s+d[aoe]\s+(semana|m[êe]s)\b/i,
      /\b(decidir|fechar|definir)\s+(at[ée]|nesta|nessa|essa)\s+semana\b/i,
      /\bpara\s+(segunda|ter[çc]a|quarta|quinta|sexta)\b/i,
    ],
    negatedBy: GENERIC_NEGATIONS,
  },
  {
    code: "ENVIOU_ESPECIFICACAO",
    label: "Envio de especificacao, lista ou documento",
    polarity: "POSITIVE",
    weight: 0.9,
    direction: "INBOUND",
    patterns: [
      /\b(segue|enviei|mandei|anexo|anexei)\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(planilha|lista|especifica[çc][ãa]o|projeto|documento|arquivo|pdf)\b/i,
      /\blista\s+de\s+(itens|materiais|produtos)\b/i,
    ],
  },
  {
    code: "ORCAMENTO_APROVADO",
    label: "Mencao a orcamento aprovado ou processo de compra",
    polarity: "POSITIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      // Aceita adverbios e verbos intermediarios: "o orcamento JA FOI aprovado",
      // "o orcamento JA ESTA liberado". Sem isso, a forma mais natural em
      // portugues passava despercebida.
      /\bor[çc]amento\s+(?:j[áa]\s+)?(?:foi\s+|est[áa]\s+|se\s+encontra\s+)?(?:aprovad[oa]|liberad[oa]|autorizad[oa])\b/i,
      /\b(diretoria|financeiro|compras|s[óo]cios?|conselho)\s+(?:j[áa]\s+)?(aprov(?:ou|aram)|liber(?:ou|aram)|autoriz(?:ou|aram))\b/i,
      /\bverba\s+(?:j[áa]\s+)?(aprovada|liberada|dispon[íi]vel)\b/i,
      /\bprocesso\s+de\s+compra\b/i,
      /\bordem\s+de\s+compra\b/i,
    ],
  },
  {
    code: "URGENCIA",
    label: "Urgencia declarada",
    polarity: "POSITIVE",
    weight: 0.9,
    direction: "INBOUND",
    patterns: [
      /\b(urgente|urg[êe]ncia|com\s+pressa|o\s+quanto\s+antes|para\s+ontem)\b/i,
      /\bpreciso\s+(hoje|agora|imediatamente)\b/i,
    ],
  },
  {
    code: "RECOMPRA",
    label: "Cliente recorrente com possivel ciclo de recompra",
    polarity: "POSITIVE",
    weight: 0.8,
    direction: "INBOUND",
    patterns: [
      /\b(comprei|adquiri|peguei)\s+(?:[\wçãõáéíóúâêô]+\s+){0,4}?(com\s+voc[êe]s|a[íi])\b/i,
      /\b(novo\s+pedido|mais\s+um\s+pedido|repor|reposi[çc][ãa]o)\b/i,
      /\bcomo\s+da\s+(?:[\wçãõáéíóúâêô]+\s+){0,2}?vez\b/i,
      /\bmesma\s+coisa\s+(?:que\s+|do\s+|da\s+)?(?:pedi|comprei)\b/i,
    ],
  },
  {
    code: "INSATISFEITO_FORNECEDOR",
    label: "Insatisfacao com fornecedor atual",
    polarity: "POSITIVE",
    weight: 0.9,
    direction: "INBOUND",
    patterns: [
      /\b(fornecedor|empresa)\s+(atual|de\s+hoje)\s+(?:[\wçãõáéíóúâêô]+\s+){0,4}?(atras(ou|ando)|n[ãa]o\s+entreg|problema|ruim)\b/i,
      /\b(estou|estamos)\s+(trocando|saindo|migrando)\s+de\s+fornecedor\b/i,
      /\b(trocando|troca)\s+de\s+fornecedor\b/i,
      /\bn[ãa]o\s+est(ou|amos)\s+satisfeit[oa]s?\s+com\b/i,
    ],
  },
  {
    code: "PROPOSTA_ENVIADA",
    label: "Proposta comercial ja enviada pela equipe",
    polarity: "POSITIVE",
    weight: 0.85,
    // Sinal de SAIDA: quem enviou a proposta foi a equipe, nao o cliente.
    direction: "OUTBOUND",
    patterns: [
      /\b(segue|enviei|mandei|anexo|encaminho)\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(proposta|or[çc]amento|cota[çc][ãa]o)\b/i,
      /\bproposta\s+(comercial|em\s+anexo|atualizada)\b/i,
      /\bvalor\s+total\s+de\s+R\$/i,
    ],
  },
  {
    code: "PEDIDO_VENDEDOR",
    label: "Pedido de contato com vendedor ou especialista",
    polarity: "POSITIVE",
    weight: 0.9,
    direction: "INBOUND",
    patterns: [
      /\b(falar|conversar)\s+com\s+(?:um\s+|o\s+)?(vendedor|consultor|especialista|comercial|atendente)\b/i,
      /\b(algu[ée]m|pessoa)\s+(pode|poderia)\s+me\s+ligar\b/i,
      /\bme\s+(liga|chama|retorna)\b/i,
    ],
  },
];

/* --------------------------------------------------------------------------
   SINAIS NEGATIVOS
   -------------------------------------------------------------------------- */
const NEGATIVE_RULES: SignalRule[] = [
  {
    code: "SUPORTE_APENAS",
    label: "Atendimento exclusivamente de suporte",
    polarity: "NEGATIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(n[ãa]o\s+(consigo|est[áa])\s+(acessar|funcionando|logar))\b/i,
      /\b(erro|bug|travou|parou\s+de\s+funcionar|defeito)\b/i,
      /\b(suporte\s+t[ée]cnico|assist[êe]ncia\s+t[ée]cnica|garantia)\b/i,
      /\b(esqueci|resetar)\s+(?:a\s+)?senha\b/i,
      /\bsegunda\s+via\s+(do\s+)?(boleto|nota)\b/i,
    ],
  },
  {
    code: "RECLAMACAO",
    label: "Reclamacao sem oportunidade comercial identificavel",
    polarity: "NEGATIVE",
    weight: 0.8,
    direction: "INBOUND",
    patterns: [
      /\b(p[ée]ssimo|horr[íi]vel|absurdo|inadmiss[íi]vel)\b/i,
      /\b(procon|reclame\s*aqui|processo|advogado)\b/i,
      /\bquero\s+(cancelar|meu\s+dinheiro\s+de\s+volta|reembolso)\b/i,
    ],
  },
  {
    code: "COMPRA_CONCLUIDA",
    label: "Compra ja concluida",
    polarity: "NEGATIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(j[áa])\s+(comprei|fechei|paguei|contratei|finalizei)\b/i,
      /\bpedido\s+(j[áa]\s+)?(realizado|feito|confirmado)\b/i,
      /\bcompra\s+(finalizada|conclu[íi]da)\b/i,
    ],
  },
  {
    code: "DESCADASTRO",
    label: "Pedido de descadastro",
    polarity: "NEGATIVE",
    weight: 1,
    direction: "INBOUND",
    patterns: [
      /\b(sair|remover|excluir|tirar)\s+(?:[\wçãõáéíóúâêô]+\s+){0,3}?(lista|cadastro|grupo)\b/i,
      /\bn[ãa]o\s+quero\s+(mais\s+)?receber\b/i,
      /\bdescadastr(ar|o)\b/i,
      /\bpare\s+de\s+(me\s+)?(enviar|mandar)\b/i,
    ],
  },
  {
    code: "SPAM",
    label: "Spam ou mensagem automatica",
    polarity: "NEGATIVE",
    weight: 1,
    patterns: [
      /\b(ganhe\s+dinheiro|clique\s+aqui\s+agora|promo[çc][ãa]o\s+imperd[íi]vel)\b/i,
      /\b(bitcoin|criptomoeda|investimento\s+garantido)\b/i,
      /\bhttps?:\/\/(bit\.ly|tinyurl)\b/i,
    ],
  },
  {
    code: "FORA_PERFIL",
    label: "Cliente fora do perfil",
    polarity: "NEGATIVE",
    weight: 0.7,
    direction: "INBOUND",
    patterns: [
      /\b(sou|somos)\s+(?:[\wçãõáéíóúâêô]+\s+){0,2}?(fornecedor|representante|vendedor)\s+(?:e\s+)?(?:gostaria|quero|queria)\b/i,
      /\b(vaga|curr[íi]culo|trabalhar|emprego|est[áa]gio)\b/i,
      /\bparceria\s+comercial\b/i,
    ],
  },
];

const ALL_RULES: SignalRule[] = [...POSITIVE_RULES, ...NEGATIVE_RULES];

/** Comprimento maximo do trecho guardado como evidencia. */
const EXCERPT_MAX = 220;

function buildExcerpt(text: string, matchIndex: number, matchLength: number): string {
  if (text.length <= EXCERPT_MAX) return text.trim();
  const half = Math.floor((EXCERPT_MAX - matchLength) / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, matchIndex + matchLength + half);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * Uma mensagem muito curta sustenta menos a conclusao do que uma mensagem
 * com contexto. Isso evita que um "quanto custa?" solto valha o mesmo que
 * uma descricao completa da necessidade.
 */
function contextStrength(text: string): number {
  const words = text.trim().split(/\s+/).length;
  if (words <= 3) return 0.45;
  if (words <= 8) return 0.7;
  if (words <= 20) return 0.9;
  return 1;
}

function ruleApplies(rule: SignalRule, message: MessageSnapshot): boolean {
  if (rule.direction && message.direction !== rule.direction) return false;
  if (rule.negatedBy?.some((re) => re.test(message.text))) return false;
  return true;
}

/**
 * Percorre as mensagens e devolve os sinais detectados, ja deduplicados
 * por codigo (mantendo a ocorrencia mais forte e mais recente).
 */
export function detectSignals(messages: MessageSnapshot[]): DetectedSignal[] {
  const bestByCode = new Map<string, DetectedSignal>();

  for (const message of messages) {
    if (!message.text || message.text.trim().length === 0) continue;

    for (const rule of ALL_RULES) {
      if (!ruleApplies(rule, message)) continue;

      for (const pattern of rule.patterns) {
        // `exec` sem flag global: sempre a primeira ocorrencia da mensagem.
        const match = pattern.exec(message.text);
        if (!match) continue;

        const strength = Number(
          (rule.weight * contextStrength(message.text)).toFixed(3),
        );

        const candidate: DetectedSignal = {
          code: rule.code,
          label: rule.label,
          polarity: rule.polarity,
          excerpt: buildExcerpt(message.text, match.index, match[0].length),
          messageId: message.id,
          sentAt: message.sentAt,
          strength,
        };

        const existing = bestByCode.get(rule.code);
        const isBetter =
          !existing ||
          candidate.strength > existing.strength ||
          (candidate.strength === existing.strength &&
            candidate.sentAt > existing.sentAt);

        if (isBetter) bestByCode.set(rule.code, candidate);
        break; // um match por regra por mensagem basta
      }
    }
  }

  return [...bestByCode.values()].sort((a, b) => b.strength - a.strength);
}

/** Extrai objecoes declaradas pelo cliente, para exibicao na oportunidade. */
const OBJECTION_RULES: { label: string; pattern: RegExp }[] = [
  { label: "Preco acima do esperado", pattern: /\b(caro|acima\s+do\s+or[çc]amento|muito\s+alto|fora\s+do\s+or[çc]amento)\b/i },
  { label: "Comparando com concorrente", pattern: /\b(concorrente|outra\s+empresa|outro\s+fornecedor|cotando\s+com)\b/i },
  { label: "Prazo de entrega longo", pattern: /\b(demora|prazo\s+(muito\s+)?longo|muito\s+tempo\s+para\s+entregar)\b/i },
  { label: "Precisa de aprovacao interna", pattern: /\b(preciso\s+(falar|verificar|alinhar)\s+com|depende\s+d[aoe]\s+(diretoria|s[óo]cio|chefe|gestor))\b/i },
  { label: "Momento inadequado", pattern: /\b(agora\s+n[ãa]o|mais\s+pra\s+frente|pr[óo]ximo\s+(m[êe]s|ano)|depois\s+eu\s+vejo)\b/i },
  { label: "Duvida tecnica nao resolvida", pattern: /\b(n[ãa]o\s+entendi|ficou\s+confuso|como\s+funciona\s+exatamente)\b/i },
];

export function detectObjections(messages: MessageSnapshot[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    if (message.direction !== "INBOUND") continue;
    for (const rule of OBJECTION_RULES) {
      if (rule.pattern.test(message.text)) found.add(rule.label);
    }
  }
  return [...found];
}

/** Exposto para testes e para a tela de configuracoes. */
export const SIGNAL_CATALOG = ALL_RULES.map((rule) => ({
  code: rule.code,
  label: rule.label,
  polarity: rule.polarity,
  weight: rule.weight,
}));
