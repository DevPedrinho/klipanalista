import "server-only";
import { interpretarData } from "./data-br";
import { declaraSessao, extrairIdDaSessao } from "./id-da-sessao";
import { normalizar, type Mapeamento } from "./mapeamento";
import type { LinhaDaPlanilha } from "./xlsx-reader";

export { extrairIdDaSessao } from "./id-da-sessao";

/**
 * A planilha como INDICE de atendimentos, nao como fonte de conteudo.
 *
 * POR QUE ESTE CAMINHO EXISTE
 *
 * Medido contra um relatorio real (15.732 linhas, 1.497 atendimentos): 18,2%
 * das mensagens sao audio sem transcricao, nao ha coluna de direcao (so
 * "De: X Para: Y", com um valor distinto por par de pessoas) e nao ha id de
 * contato. Ler a conversa da planilha perde tudo isso.
 *
 * A API tem os tres — transcricao, direcao e contato —, e a busca direta por
 * id (`GET /v2/session/{id}`) nao sofre o limite de paginacao da listagem. O
 * que faltava era saber QUAIS ids existem fora da janela recente. E isso que
 * a planilha da: a coluna `Conversa` traz o link do atendimento, e o id sai
 * dele.
 *
 * Por isso daqui so sai a lista de ids. Nome, telefone e datas vem junto
 * apenas para a pessoa reconhecer o que vai ser buscado — nunca entram na
 * analise, que le a versao da API.
 */

const NOME_DE_COLUNA_DE_SESSAO = /\b(atendimento|conversa|sessao|session|chat|ticket|protocolo)\b/;

/** Fracao minima de celulas preenchidas que precisam render um id. */
const MINIMO_RECONHECIDO = 0.9;

export interface ColunaCandidata {
  coluna: string;
  /** 0 a 1. */
  confianca: number;
  porque: string;
}

/**
 * Escolhe a coluna que identifica o atendimento.
 *
 * O concorrente perigoso e a coluna de id da MENSAGEM: tambem e UUID em toda
 * linha, e escolhe-la geraria uma busca por linha — 15.732 chamadas que
 * dariam 404, em vez de 1.497 que funcionam. Tres sinais separam as duas:
 *
 *   - o link declara `type=SESSION`;
 *   - o cabecalho fala em conversa/atendimento;
 *   - o id se REPETE entre linhas, porque um atendimento tem varias mensagens.
 *     Id de mensagem nunca se repete.
 *
 * O conteudo e condicao, nao pontuacao: coluna que nao rende id em quase toda
 * linha preenchida nao e candidata, por melhor que seja o nome.
 */
export function detectarColunaDaSessao(
  cabecalhos: string[],
  linhas: LinhaDaPlanilha[],
): ColunaCandidata | null {
  let melhor: ColunaCandidata | null = null;
  let pontosDoMelhor = -Infinity;

  for (const coluna of cabecalhos) {
    const preenchidas = linhas
      .map((l) => l.valores[coluna] ?? "")
      .filter((v) => v.trim().length > 0);
    if (preenchidas.length === 0) continue;

    const ids = preenchidas.map(extrairIdDaSessao);
    const reconhecidos = ids.filter((id): id is string => id !== null);
    if (reconhecidos.length / preenchidas.length < MINIMO_RECONHECIDO) continue;

    const motivos: string[] = [];
    let pontos = 0.4;

    if (preenchidas.some(declaraSessao)) {
      pontos += 0.3;
      motivos.push("o link aponta para um atendimento");
    }
    if (NOME_DE_COLUNA_DE_SESSAO.test(normalizar(coluna))) {
      pontos += 0.2;
      motivos.push("o nome da coluna fala em conversa");
    }
    if (new Set(reconhecidos).size < reconhecidos.length) {
      motivos.push("o mesmo id se repete entre mensagens");
    } else if (reconhecidos.length > 1) {
      // Id unico por linha e o retrato de id de mensagem.
      pontos -= 0.3;
    }

    if (pontos > pontosDoMelhor) {
      pontosDoMelhor = pontos;
      melhor = {
        coluna,
        confianca: Math.max(0, Math.min(1, pontos)),
        porque: motivos.length > 0 ? motivos.join("; ") : "todas as linhas trazem um id",
      };
    }
  }

  return melhor;
}

export interface SessaoDoIndice {
  sessionId: string;
  /** Quantas linhas da planilha citam este atendimento. */
  linhas: number;
  /** So para a pessoa reconhecer o atendimento na previa. */
  contatoNome?: string;
  telefone?: string;
  canal?: string;
  /** ISO. Ausente quando a planilha nao tem data legivel. */
  primeiraMensagem?: string;
  ultimaMensagem?: string;
}

export interface IndiceDeSessoes {
  coluna: string;
  sessoes: SessaoDoIndice[];
  totalDeLinhas: number;
  /**
   * Linhas cuja celula nao rendeu id. Contadas e mostradas, nunca descartadas
   * em silencio: se forem muitas, a coluna escolhida esta errada.
   */
  linhasSemId: { quantidade: number; exemplos: number[]; amostraDeValores: string[] };
}

const EXEMPLOS = 5;

/**
 * Monta a lista de atendimentos unicos a partir da coluna escolhida.
 *
 * `extras` aponta as colunas de nome, telefone, canal e data — as mesmas que o
 * mapeamento ja propoe. Todas opcionais: sem elas a lista sai so com os ids,
 * e a busca funciona igual.
 *
 * A ordem e do atendimento mais recente para o mais antigo. A importacao de
 * um mes leva minutos; se a pessoa parar no meio, o que ja foi lido e o que
 * mais importa.
 */
export function montarIndiceDeSessoes(
  linhas: LinhaDaPlanilha[],
  coluna: string,
  extras: Pick<Mapeamento, "contatoNome" | "telefone" | "canal" | "dataHora"> = {},
): IndiceDeSessoes {
  const porId = new Map<string, SessaoDoIndice & { _primeira?: number; _ultima?: number }>();
  const semId: IndiceDeSessoes["linhasSemId"] = { quantidade: 0, exemplos: [], amostraDeValores: [] };

  const ler = (linha: LinhaDaPlanilha, campo: string | undefined) =>
    campo ? (linha.valores[campo] ?? "").trim() : "";

  for (const linha of linhas) {
    const bruto = linha.valores[coluna] ?? "";
    const sessionId = extrairIdDaSessao(bruto);

    if (!sessionId) {
      semId.quantidade += 1;
      if (semId.exemplos.length < EXEMPLOS) semId.exemplos.push(linha.numero);
      const valor = bruto.trim().slice(0, 80);
      if (semId.amostraDeValores.length < EXEMPLOS && !semId.amostraDeValores.includes(valor)) {
        semId.amostraDeValores.push(valor);
      }
      continue;
    }

    let sessao = porId.get(sessionId);
    if (!sessao) {
      sessao = { sessionId, linhas: 0 };
      porId.set(sessionId, sessao);
    }
    sessao.linhas += 1;

    sessao.contatoNome ||= ler(linha, extras.contatoNome) || undefined;
    sessao.telefone ||= ler(linha, extras.telefone) || undefined;
    sessao.canal ||= ler(linha, extras.canal) || undefined;

    const instante = interpretarData(ler(linha, extras.dataHora));
    if (instante !== null) {
      if (sessao._primeira === undefined || instante < sessao._primeira) sessao._primeira = instante;
      if (sessao._ultima === undefined || instante > sessao._ultima) sessao._ultima = instante;
    }
  }

  const sessoes = [...porId.values()]
    .sort((a, b) => (b._ultima ?? -Infinity) - (a._ultima ?? -Infinity))
    .map(({ _primeira, _ultima, ...sessao }) => ({
      ...sessao,
      ...(_primeira === undefined ? {} : { primeiraMensagem: new Date(_primeira).toISOString() }),
      ...(_ultima === undefined ? {} : { ultimaMensagem: new Date(_ultima).toISOString() }),
    }));

  return { coluna, sessoes, totalDeLinhas: linhas.length, linhasSemId: semId };
}
