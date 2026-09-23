import "server-only";

/**
 * Leitura do id do atendimento numa celula de planilha.
 *
 * Separado de `indice-de-sessoes.ts` porque a deteccao de colunas
 * (`mapeamento.ts`) tambem precisa dele, e as duas leituras tem de ser a
 * MESMA: se divergissem, a coluna seria proposta por uma regra e recusada
 * linha a linha pela outra.
 */

const UUID_CRU = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_NO_PARAMETRO =
  /[?&]id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/i;
const TIPO_NO_PARAMETRO = /[?&]type=([^&#]*)/i;

/**
 * Tira o id do atendimento de uma celula: UUID solto ou link com `?id=`.
 *
 * Um link que declara OUTRO tipo (`type=CONTACT`, `type=CARD`) e recusado. O
 * id dele e de contato ou de card, e busca-lo como sessao daria 404 em cada
 * linha — ou pior, se um dia colidir, a conversa errada.
 *
 * O id volta em minusculas: UUID nao diferencia caixa, e sem isso o mesmo
 * atendimento escrito de dois jeitos contaria duas vezes.
 */
export function extrairIdDaSessao(celula: string): string | null {
  const texto = celula.trim();
  if (!texto) return null;

  if (UUID_CRU.test(texto)) return texto.toLowerCase();

  const id = UUID_NO_PARAMETRO.exec(texto)?.[1];
  if (!id) return null;

  const tipo = TIPO_NO_PARAMETRO.exec(texto)?.[1];
  if (tipo !== undefined && tipo.toUpperCase() !== "SESSION") return null;

  return id.toLowerCase();
}

/** true quando a celula e um link que se declara atendimento. */
export function declaraSessao(celula: string): boolean {
  return TIPO_NO_PARAMETRO.exec(celula)?.[1]?.toUpperCase() === "SESSION";
}
