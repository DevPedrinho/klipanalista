import "server-only";
import ExcelJS from "exceljs";

/**
 * Leitor de planilha `.xlsx`.
 *
 * POR QUE ISTO EXISTE
 *
 * A leitura pela API custa caro nesta conta: 22.213 conversas, sem filtro de
 * data nem ordenacao, listadas da mais antiga para a mais nova. O modulo le de
 * tras para frente, com teto de 60 conversas e orcamento de 35 segundos — uma
 * janela estreita e recente, e nada alem dela.
 *
 * O relatorio exportado da propria KlipFlowi nao tem nenhum desses limites: vem
 * inteiro, de uma vez, e o recorte e escolha de quem exporta.
 *
 * O QUE ESTE MODULO NAO FAZ
 *
 * Nao decide o que cada coluna significa. Ele devolve cabecalhos e linhas como
 * texto; quem interpreta e `mapeamento.ts`, com confirmacao humana. A separacao
 * importa porque nao sabemos o formato exato do relatorio, ele muda entre
 * versoes da plataforma, e contas diferentes exportam colunas diferentes.
 */

/**
 * Uma linha de dados.
 *
 * O numero e o da linha NO ARQUIVO, nao o indice no array. Linhas vazias e o
 * cabecalho sao descartados na leitura, entao os dois divergem — e quem for
 * conferir um erro vai abrir a planilha e procurar a linha 42, nao a
 * trigesima do array.
 */
export interface LinhaDaPlanilha {
  numero: number;
  valores: Record<string, string>;
}

/** Uma planilha lida: o que tem dentro, sem nenhuma interpretacao. */
export interface PlanilhaLida {
  /** Nome de todas as abas, para quem precisar escolher outra. */
  abas: string[];
  /** Aba efetivamente lida. */
  abaLida: string;
  cabecalhos: string[];
  /** Cada linha na ordem do arquivo. */
  linhas: LinhaDaPlanilha[];
  /** Linhas ignoradas por estarem vazias. */
  linhasVazias: number;
}

export class PlanilhaInvalida extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanilhaInvalida";
  }
}

/**
 * Converte uma celula em texto.
 *
 * O `.xlsx` guarda tipos, e cada um chega de um jeito. Data e o caso que mais
 * importa: o Excel a guarda como numero de serie, e uma leitura ingenua entrega
 * `45916` no lugar de `2026-09-16`. Como a data e o que ordena as mensagens e
 * define a recencia da conversa, errar aqui estraga a analise inteira em
 * silencio — por isso ela vira ISO 8601, que e o formato que o resto do modulo
 * ja fala.
 */
function textoDaCelula(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return "";

  if (valor instanceof Date) return valor.toISOString();

  if (typeof valor === "string") return valor;
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);

  if (typeof valor === "object") {
    // Texto formatado: pedacos com estilos diferentes na mesma celula.
    if ("richText" in valor && Array.isArray(valor.richText)) {
      return valor.richText.map((parte) => parte.text ?? "").join("");
    }
    // Link: o que interessa e o texto exibido, nao o endereco.
    if ("text" in valor && typeof valor.text === "string") return valor.text;
    // Formula: vale o resultado calculado, nao a formula.
    if ("result" in valor) {
      const resultado = (valor as { result?: ExcelJS.CellValue }).result;
      return resultado === undefined ? "" : textoDaCelula(resultado);
    }
    // Celula em erro (#REF!, #N/A) equivale a vazia.
    if ("error" in valor) return "";
    if ("hyperlink" in valor) return String((valor as { hyperlink: string }).hyperlink);
  }

  return String(valor);
}

/** Assinatura de arquivo zip — todo `.xlsx` e um zip. */
export function pareceXlsx(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 && // P
    buffer[1] === 0x4b && // K
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  );
}

/**
 * Nomeia cabecalhos repetidos ou vazios.
 *
 * Relatorio exportado costuma trazer coluna sem titulo, e duas colunas com o
 * mesmo nome fariam uma sobrescrever a outra ao virar chave do objeto — perda
 * de dados silenciosa, que e exatamente o que este modulo existe para evitar.
 */
function cabecalhosUnicos(brutos: string[]): string[] {
  const vistos = new Map<string, number>();

  return brutos.map((bruto, indice) => {
    const base = bruto.trim() || `Coluna ${indice + 1}`;
    const quantos = vistos.get(base) ?? 0;
    vistos.set(base, quantos + 1);
    return quantos === 0 ? base : `${base} (${quantos + 1})`;
  });
}

export interface OpcoesDeLeitura {
  /** Nome da aba. Sem isso, a primeira que tiver conteudo. */
  aba?: string;
  /** Teto de linhas de dados lidas. */
  maxLinhas?: number;
}

/** Teto padrao de linhas. Acima disso a resposta nao caberia na requisicao. */
export const MAX_LINHAS_PADRAO = 50_000;

export async function lerPlanilha(
  buffer: Buffer,
  opcoes: OpcoesDeLeitura = {},
): Promise<PlanilhaLida> {
  if (!pareceXlsx(buffer)) {
    throw new PlanilhaInvalida(
      "O arquivo nao parece uma planilha .xlsx. Exporte o relatorio novamente em " +
        "Excel — .csv e .xls antigo nao servem.",
    );
  }

  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (erro) {
    throw new PlanilhaInvalida(
      "Nao foi possivel abrir a planilha: " +
        (erro instanceof Error ? erro.message : String(erro)),
    );
  }

  const abas = workbook.worksheets.map((w) => w.name);
  if (abas.length === 0) throw new PlanilhaInvalida("A planilha nao tem nenhuma aba.");

  const escolhida = opcoes.aba
    ? workbook.worksheets.find((w) => w.name === opcoes.aba)
    : workbook.worksheets.find((w) => w.actualRowCount > 0) ?? workbook.worksheets[0];

  if (!escolhida) {
    throw new PlanilhaInvalida(
      `A aba "${opcoes.aba}" nao existe. Abas disponiveis: ${abas.join(", ")}.`,
    );
  }

  /*
   * A primeira linha com conteudo e o cabecalho.
   *
   * Relatorio exportado as vezes comeca com linhas de titulo ou filtros em
   * branco; pular ate achar conteudo evita ler "" como nome de coluna.
   */
  let linhaDoCabecalho = 0;
  let cabecalhos: string[] = [];

  escolhida.eachRow({ includeEmpty: false }, (row, numero) => {
    if (linhaDoCabecalho !== 0) return;

    const valores = (row.values as ExcelJS.CellValue[]).slice(1).map(textoDaCelula);
    if (valores.some((v) => v.trim().length > 0)) {
      linhaDoCabecalho = numero;
      cabecalhos = cabecalhosUnicos(valores);
    }
  });

  if (linhaDoCabecalho === 0 || cabecalhos.length === 0) {
    throw new PlanilhaInvalida(
      `A aba "${escolhida.name}" esta vazia — nao ha cabecalho para ler.`,
    );
  }

  const maxLinhas = opcoes.maxLinhas ?? MAX_LINHAS_PADRAO;
  const linhas: LinhaDaPlanilha[] = [];
  let linhasVazias = 0;

  escolhida.eachRow({ includeEmpty: false }, (row, numero) => {
    if (numero <= linhaDoCabecalho) return;
    if (linhas.length >= maxLinhas) return;

    const celulas = (row.values as ExcelJS.CellValue[]).slice(1);
    const valores: Record<string, string> = {};
    let temConteudo = false;

    cabecalhos.forEach((cabecalho, indice) => {
      const texto = textoDaCelula(celulas[indice] ?? null);
      valores[cabecalho] = texto;
      if (texto.trim().length > 0) temConteudo = true;
    });

    if (!temConteudo) {
      linhasVazias += 1;
      return;
    }

    linhas.push({ numero, valores });
  });

  return { abas, abaLida: escolhida.name, cabecalhos, linhas, linhasVazias };
}
