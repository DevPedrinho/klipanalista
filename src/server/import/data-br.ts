import "server-only";

/**
 * Interpretacao de data vinda de planilha.
 *
 * POR QUE NAO DA PARA USAR `Date.parse` DIRETO
 *
 * Duas medicoes, as duas graves:
 *
 *   `Date.parse("data invalida numero 0")` devolve 1º de janeiro de 2000.
 *   Ou seja, ele INVENTA uma data a partir de texto que nao e data nenhuma.
 *   Numa coluna mapeada por engano, isso nao daria erro: daria uma conversa
 *   inteira reordenada com carimbos fabricados.
 *
 *   `Date.parse("16/09/2026")` devolve `NaN`. O formato brasileiro, que e
 *   justamente o que um relatorio em portugues traz, nao e reconhecido. Sem
 *   tratamento, o importador rejeitaria a planilha inteira dizendo "data
 *   ilegivel" em todas as linhas.
 *
 * Entao a leitura aqui e por FORMATO DECLARADO: o que nao casar com um dos
 * padroes conhecidos e recusado. Recusar e barato — a tela diz qual valor nao
 * foi entendido e a pessoa corrige o mapeamento. Aceitar errado e caro, porque
 * nao aparece.
 */

/**
 * Fuso assumido para data e hora sem fuso declarado.
 *
 * O relatorio e exportado por uma empresa brasileira e traz hora local. Ler
 * como UTC deslocaria tudo em tres horas — pouco para a maioria das contas, e
 * o bastante para errar "sem resposta ha X horas" na virada do dia.
 *
 * O Brasil nao tem mais horario de verao desde 2019, entao um deslocamento
 * fixo esta correto o ano inteiro. Sobrescritivel para instalacoes em outro
 * fuso.
 */
export function fusoPadrao(): string {
  const bruto = process.env["FLW_FUSO_PLANILHA"]?.trim();
  return bruto && /^[+-]\d{2}:\d{2}$/.test(bruto) ? bruto : "-03:00";
}

/** ISO 8601 com fuso declarado — o que o proprio `.xlsx` entrega. */
const ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** ISO 8601 sem fuso: precisa do fuso assumido. */
const ISO_SEM_FUSO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Formato brasileiro: dia primeiro. */
const BR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

function valida(ano: number, mes: number, dia: number): boolean {
  if (mes < 1 || mes > 12) return false;
  if (dia < 1 || dia > 31) return false;
  if (ano < 1970 || ano > 2999) return false;

  // Rejeita 31 de fevereiro e afins: o Date rola para o mes seguinte em
  // silencio, e uma data rolada e pior que uma data recusada.
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

function montar(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  segundo: number,
): number | null {
  if (!valida(ano, mes, dia)) return null;
  if (hora > 23 || minuto > 59 || segundo > 59) return null;

  const dois = (n: number) => String(n).padStart(2, "0");
  const texto =
    `${ano}-${dois(mes)}-${dois(dia)}T${dois(hora)}:${dois(minuto)}:${dois(segundo)}` +
    fusoPadrao();

  const instante = Date.parse(texto);
  return Number.isFinite(instante) ? instante : null;
}

/**
 * Interpreta uma data de planilha. Devolve o instante em ms, ou `null`.
 *
 * `null` e uma resposta legitima e frequente — quem chama transforma em
 * rejeicao nomeada, com o valor recusado a vista.
 */
export function interpretarData(bruto: string): number | null {
  const texto = bruto.trim();
  if (!texto) return null;

  // Numero solto nunca e data. "5" vira ano 2005 em varios parsers, e uma
  // coluna de quantidade viraria a coluna de data.
  if (/^\d+([.,]\d+)?$/.test(texto)) return null;

  if (ISO_COM_FUSO.test(texto)) {
    const instante = Date.parse(texto.replace(" ", "T"));
    return Number.isFinite(instante) ? instante : null;
  }

  const iso = ISO_SEM_FUSO.exec(texto);
  if (iso) {
    return montar(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    );
  }

  const br = BR.exec(texto);
  if (br) {
    /*
     * Dia primeiro, sempre.
     *
     * `03/04/2026` e ambiguo entre 3 de abril e 4 de marco, e nao ha como
     * desfazer a ambiguidade linha a linha. A plataforma e brasileira e o
     * relatorio sai em portugues, entao dia-mes e a leitura certa — e uma
     * escolha fixa erra de forma previsivel, enquanto uma heuristica por
     * linha erraria so em algumas, que e impossivel de perceber.
     */
    return montar(
      Number(br[3]),
      Number(br[2]),
      Number(br[1]),
      Number(br[4] ?? 0),
      Number(br[5] ?? 0),
      Number(br[6] ?? 0),
    );
  }

  return null;
}

/** true quando o texto e uma data que sabemos ler. */
export function ehDataLegivel(bruto: string): boolean {
  return interpretarData(bruto) !== null;
}
