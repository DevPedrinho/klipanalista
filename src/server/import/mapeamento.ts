import "server-only";

/**
 * De que coluna da planilha sai cada informacao.
 *
 * POR QUE ISTO E DIRIGIDO POR CONFIRMACAO, E NAO POR ADIVINHACAO
 *
 * Nao sabemos o formato exato do relatorio da KlipFlowi: ele muda entre
 * versoes da plataforma e contas diferentes exportam colunas diferentes.
 * Codificar os nomes das colunas de hoje daria um importador que quebra
 * calado na proxima exportacao.
 *
 * Entao o modulo PROPOE e a pessoa CONFIRMA. A proposta combina duas
 * heuristicas independentes — o nome do cabecalho e o formato dos valores —
 * porque cada uma sozinha erra: um relatorio em ingles derrota a primeira,
 * e uma coluna de id parece outra coluna de id para a segunda.
 */

export const CAMPOS_ALVO = [
  "sessionId",
  "texto",
  "direcao",
  "dataHora",
  "contatoId",
  "telefone",
  "contatoNome",
  "canal",
  "atendenteId",
  "atendenteNome",
] as const;

export type CampoAlvo = (typeof CAMPOS_ALVO)[number];

export interface DefinicaoDeCampo {
  campo: CampoAlvo;
  rotulo: string;
  obrigatorio: boolean;
  /** Por que este campo importa — aparece na tela de mapeamento. */
  paraQue: string;
  /** Heuristica pelo NOME do cabecalho. */
  padroes: RegExp[];
  /** Heuristica pelo FORMATO dos valores: 0 a 1. */
  pontuarValores?: (amostra: string[]) => number;
}

/** Normaliza para comparar: minusculas, sem acento, sem pontuacao. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fracao da amostra que satisfaz um teste, ignorando celulas vazias. */
function fracao(amostra: string[], teste: (v: string) => boolean): number {
  const preenchidos = amostra.filter((v) => v.trim().length > 0);
  if (preenchidos.length === 0) return 0;
  return preenchidos.filter(teste).length / preenchidos.length;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ehData(valor: string): boolean {
  // Numero solto nao conta: "5" vira data em muitos parsers, e uma coluna de
  // quantidade viraria a coluna de data.
  if (/^\d+([.,]\d+)?$/.test(valor.trim())) return false;
  return Number.isFinite(Date.parse(valor));
}

function ehTelefone(valor: string): boolean {
  const digitos = valor.replace(/\D/g, "");
  return digitos.length >= 10 && digitos.length <= 15;
}

/**
 * Vocabularios de direcao que ja encontramos.
 *
 * `FROM_HUB`/`TO_HUB` e o vocabulario da propria API da KlipFlowi, e foi uma
 * armadilha cara: `FROM_HUB` parece "vindo do sistema" e significa o oposto —
 * mensagem do CLIENTE. Errar isso atribui cada fala do cliente a equipe e
 * inverte a analise inteira.
 */
const DIRECAO_ENTRADA = [
  "recebida", "recebido", "entrada", "cliente", "contato", "in", "inbound",
  "from hub", "from_hub", "recebidas",
];
const DIRECAO_SAIDA = [
  "enviada", "enviado", "saida", "atendente", "operador", "agente", "out",
  "outbound", "to hub", "to_hub", "empresa", "enviadas",
];

function ehDirecao(valor: string): boolean {
  const n = normalizar(valor);
  return DIRECAO_ENTRADA.includes(n) || DIRECAO_SAIDA.includes(n);
}

export const DEFINICOES: DefinicaoDeCampo[] = [
  {
    campo: "sessionId",
    rotulo: "Atendimento (id)",
    obrigatorio: true,
    paraQue:
      "Agrupa as mensagens numa conversa. Sem isso cada linha vira um atendimento solto.",
    padroes: [/\b(id|codigo|numero)?\s*(do\s*)?(atendimento|conversa|sessao|session|ticket|protocolo)\b/],
    pontuarValores: (a) => Math.max(fracao(a, (v) => UUID.test(v.trim())), 0),
  },
  {
    campo: "texto",
    rotulo: "Mensagem",
    obrigatorio: true,
    paraQue: "É o que a análise lê. Sem a mensagem não há o que analisar.",
    padroes: [/\b(mensagem|texto|conteudo|message|body|transcricao|descricao)\b/],
    // Texto livre: mensagens são longas e variadas, ids e datas não são.
    pontuarValores: (a) => {
      const media = a.reduce((soma, v) => soma + v.length, 0) / Math.max(1, a.length);
      const variados = new Set(a).size / Math.max(1, a.length);
      return media > 25 && variados > 0.5 ? Math.min(1, media / 120) : 0;
    },
  },
  {
    campo: "direcao",
    rotulo: "Quem enviou",
    obrigatorio: true,
    paraQue:
      "Distingue o que o cliente disse do que a equipe respondeu. Trocar os dois inverte a análise inteira.",
    padroes: [/\b(direcao|sentido|origem|tipo|remetente|quem|enviado\s*por|autor|direction|sender)\b/],
    pontuarValores: (a) => fracao(a, ehDirecao),
  },
  {
    campo: "dataHora",
    rotulo: "Data e hora",
    obrigatorio: true,
    paraQue: "Ordena as mensagens e define a recência da conversa.",
    padroes: [/\b(data|hora|quando|criado|enviado|timestamp|date|sent|envio)\b/],
    pontuarValores: (a) => fracao(a, ehData),
  },
  {
    campo: "contatoId",
    rotulo: "Contato (id)",
    obrigatorio: false,
    paraQue:
      "É o que permite etiquetar e criar card de volta na KlipFlowi. Sem ele (e sem telefone) dá para analisar, mas não para escrever.",
    padroes: [/\b(id|codigo)?\s*(do\s*)?(contato|cliente|lead|contact|customer)\b/],
    pontuarValores: (a) => fracao(a, (v) => UUID.test(v.trim())),
  },
  {
    campo: "telefone",
    rotulo: "Telefone",
    obrigatorio: false,
    paraQue: "Alternativa ao id do contato: a API aceita etiquetar pelo telefone.",
    padroes: [/\b(telefone|celular|whatsapp|fone|phone|numero\s*do\s*cliente|msisdn)\b/],
    pontuarValores: (a) => fracao(a, ehTelefone),
  },
  {
    campo: "contatoNome",
    rotulo: "Nome do contato",
    obrigatorio: false,
    paraQue: "Aparece no card da oportunidade.",
    padroes: [/\b(nome|cliente|contato|name)\b/],
  },
  {
    campo: "canal",
    rotulo: "Canal",
    obrigatorio: false,
    paraQue: "WhatsApp, Instagram, e-mail. Sem isso o canal aparece como “outro”.",
    padroes: [/\b(canal|channel|midia|meio|origem\s*do\s*contato)\b/],
  },
  {
    campo: "atendenteId",
    rotulo: "Atendente (id)",
    obrigatorio: false,
    paraQue: "Define quem vê o quê, quando o perfil não é administrador.",
    padroes: [/\b(id|codigo)?\s*(do\s*)?(atendente|operador|agente|responsavel|usuario|agent|user)\b/],
    pontuarValores: (a) => fracao(a, (v) => UUID.test(v.trim())),
  },
  {
    campo: "atendenteNome",
    rotulo: "Nome do atendente",
    obrigatorio: false,
    paraQue: "Aparece no relatório de qualidade por atendente.",
    padroes: [/\b(atendente|operador|agente|responsavel|vendedor)\b/],
  },
];

export type Mapeamento = Partial<Record<CampoAlvo, string>>;

export interface SugestaoDeColuna {
  campo: CampoAlvo;
  coluna?: string;
  /** 0 a 1. Abaixo de 0,5 a tela pede confirmação explícita. */
  confianca: number;
  /** Como a coluna foi escolhida — aparece na tela para a pessoa julgar. */
  porque: string;
}

export interface PropostaDeMapeamento {
  mapeamento: Mapeamento;
  sugestoes: SugestaoDeColuna[];
  /** Campos obrigatórios que nenhuma coluna preencheu. */
  faltando: CampoAlvo[];
}

/** Quantas linhas bastam para reconhecer o formato de uma coluna. */
const AMOSTRA = 40;

/**
 * Propoe de que coluna sai cada campo.
 *
 * A pontuacao soma nome e conteudo em vez de escolher um: o nome sozinho
 * erra em relatorio traduzido ou com cabecalho generico ("Coluna 3"), e o
 * conteudo sozinho nao distingue duas colunas de UUID. Quando as duas
 * concordam, a confianca fica alta e a tela nao precisa insistir.
 */
export function proporMapeamento(
  cabecalhos: string[],
  linhas: Record<string, string>[],
): PropostaDeMapeamento {
  const amostraPorColuna = new Map<string, string[]>();
  for (const cabecalho of cabecalhos) {
    amostraPorColuna.set(
      cabecalho,
      linhas.slice(0, AMOSTRA).map((l) => l[cabecalho] ?? ""),
    );
  }

  interface Candidato {
    campo: CampoAlvo;
    coluna: string;
    pontos: number;
    porNome: boolean;
    porValor: boolean;
  }

  const candidatos: Candidato[] = [];

  for (const definicao of DEFINICOES) {
    for (const coluna of cabecalhos) {
      const nome = normalizar(coluna);
      const amostra = amostraPorColuna.get(coluna) ?? [];

      const porNome = definicao.padroes.some((p) => p.test(nome));
      const pontosDeValor = definicao.pontuarValores?.(amostra) ?? 0;

      // Só conta como evidência de conteúdo quando a maioria da amostra bate.
      const porValor = pontosDeValor >= 0.7;

      const pontos = (porNome ? 0.6 : 0) + pontosDeValor * 0.6;
      if (pontos <= 0) continue;

      candidatos.push({ campo: definicao.campo, coluna, pontos, porNome, porValor });
    }
  }

  // Guloso pelo melhor par: uma coluna serve a um campo só, e vice-versa.
  candidatos.sort((a, b) => b.pontos - a.pontos);

  const mapeamento: Mapeamento = {};
  const colunasUsadas = new Set<string>();
  const escolhidos = new Map<CampoAlvo, Candidato>();

  for (const candidato of candidatos) {
    if (escolhidos.has(candidato.campo)) continue;
    if (colunasUsadas.has(candidato.coluna)) continue;

    escolhidos.set(candidato.campo, candidato);
    colunasUsadas.add(candidato.coluna);
    mapeamento[candidato.campo] = candidato.coluna;
  }

  const sugestoes: SugestaoDeColuna[] = DEFINICOES.map((definicao) => {
    const escolhido = escolhidos.get(definicao.campo);

    if (!escolhido) {
      return {
        campo: definicao.campo,
        confianca: 0,
        porque: "Nenhuma coluna pareceu servir.",
      };
    }

    const porque =
      escolhido.porNome && escolhido.porValor
        ? "O nome da coluna e o formato dos valores concordam."
        : escolhido.porNome
          ? "Reconhecida pelo nome da coluna."
          : "Reconhecida pelo formato dos valores.";

    return {
      campo: definicao.campo,
      coluna: escolhido.coluna,
      confianca: Math.min(1, escolhido.pontos),
      porque,
    };
  });

  const faltando = DEFINICOES.filter(
    (d) => d.obrigatorio && mapeamento[d.campo] === undefined,
  ).map((d) => d.campo);

  return { mapeamento, sugestoes, faltando };
}

/* ==========================================================================
   Vocabulario da coluna de direcao
   ========================================================================== */

export interface LeituraDaDirecao {
  /** Cada valor distinto encontrado e o lado para o qual ele foi lido. */
  valores: { valor: string; lado: "INBOUND" | "OUTBOUND" | "DESCONHECIDO" }[];
  /** true quando algum valor nao foi reconhecido — a tela precisa perguntar. */
  precisaConfirmar: boolean;
}

/**
 * Descobre o que cada valor da coluna de direcao significa.
 *
 * Isto NAO e detalhe: trocar os dois lados atribui cada fala do cliente a
 * equipe. Foi exatamente o que aconteceu na leitura pela API, onde
 * `FROM_HUB` — que parece "saiu do sistema" — significa mensagem RECEBIDA do
 * cliente. Por isso os valores nao reconhecidos sao devolvidos como
 * DESCONHECIDO em vez de cair num lado por padrao.
 */
export function lerVocabularioDaDirecao(valoresBrutos: string[]): LeituraDaDirecao {
  const distintos = [...new Set(valoresBrutos.map((v) => v.trim()).filter(Boolean))];

  const valores = distintos.map((valor) => {
    const n = normalizar(valor);
    const lado: "INBOUND" | "OUTBOUND" | "DESCONHECIDO" = DIRECAO_ENTRADA.includes(n)
      ? "INBOUND"
      : DIRECAO_SAIDA.includes(n)
        ? "OUTBOUND"
        : "DESCONHECIDO";
    return { valor, lado };
  });

  return {
    valores,
    precisaConfirmar: valores.some((v) => v.lado === "DESCONHECIDO"),
  };
}
