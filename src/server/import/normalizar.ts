import "server-only";
import type { ContactSnapshot, ConversationSnapshot, MessageSnapshot } from "@/domain/types";
import { normalizeChannel } from "@/server/integration/adapters/sessions.adapter";
import { interpretarData } from "./data-br";
import { extrairIdDaSessao } from "./id-da-sessao";
import type { Mapeamento } from "./mapeamento";
import type { LinhaDaPlanilha } from "./xlsx-reader";

/**
 * Converte linhas da planilha nas conversas que o motor de analise entende.
 *
 * Depois desta funcao nao ha mais nada de planilha: o que sai e exatamente o
 * mesmo `ConversationSnapshot` que os adapters produzem a partir da API. E o
 * que permite as duas entradas usarem o mesmo motor em vez de cada uma ganhar
 * uma copia que envelhece em paralelo.
 *
 * O QUE ELA RECUSA, E POR QUE DIZ EM VOZ ALTA
 *
 * Uma linha sem data, sem direcao ou sem texto nao vira mensagem. O risco aqui
 * nao e rejeitar: e rejeitar em silencio. Um mapeamento errado pode descartar
 * metade do relatorio, e sem relatorio de rejeicao a tela mostraria "12
 * oportunidades" com a mesma cara de quem analisou tudo.
 *
 * Por isso as rejeicoes voltam AGRUPADAS por motivo, com a contagem e alguns
 * numeros de linha como exemplo — mesma licao que o `MappingReport` dos
 * adapters aprendeu quando repetiu a mesma frase 500 vezes e produziu uma
 * resposta de 260 KB.
 */

/** Um motivo de rejeicao, com quantas linhas cairam nele. */
export interface RejeicaoAgrupada {
  /**
   * A CATEGORIA do problema, sem o valor que o causou.
   *
   * O valor fica em `amostraDeValores`, e nao aqui, porque colar "ontem" ou
   * "31/02/2026" dentro do motivo criaria um grupo por valor distinto — que e
   * o mesmo defeito que se queria evitar, so que disfarcado: trezentas datas
   * ruins diferentes voltariam como trezentos motivos.
   */
  motivo: string;
  quantidade: number;
  /** Ate cinco numeros de linha, para quem for conferir na planilha. */
  exemplos: number[];
  /** Ate tres valores distintos que causaram o problema. */
  amostraDeValores: string[];
}

export interface ResultadoDaNormalizacao {
  conversas: ConversationSnapshot[];
  contatos: ContactSnapshot[];
  /** Mensagens efetivamente aproveitadas. */
  mensagens: number;
  rejeicoes: RejeicaoAgrupada[];
  /** Nao impedem a analise, mas mudam o que da para fazer depois. */
  avisos: string[];
}

export interface OpcoesDeNormalizacao {
  accountId: string;
  mapeamento: Mapeamento;
  /**
   * O que cada valor da coluna de direcao significa.
   *
   * Vem confirmado pela tela em vez de deduzido aqui: trocar os dois lados
   * atribui cada fala do cliente a equipe e inverte a analise inteira.
   */
  direcoes: Record<string, "INBOUND" | "OUTBOUND">;
}

/**
 * Prefixo de identidade provisoria.
 *
 * Quando o relatorio nao traz o id do contato, a conversa ainda precisa de um
 * identificador para ligar mensagens e contato. O telefone serve para isso —
 * mas NAO serve para escrever de volta: a API espera o id da plataforma. O
 * prefixo deixa essa diferenca visivel em vez de deixar um id falso passar por
 * verdadeiro.
 */
export const PREFIXO_TELEFONE = "tel:";

/** true quando o id do contato ainda precisa ser resolvido na plataforma. */
export function identidadeProvisoria(contactId: string): boolean {
  return contactId.startsWith(PREFIXO_TELEFONE);
}

function apenasDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

class Rejeicoes {
  private readonly porMotivo = new Map<
    string,
    { quantidade: number; exemplos: number[]; valores: Set<string> }
  >();

  registrar(motivo: string, linha: number, valor?: string): void {
    const atual =
      this.porMotivo.get(motivo) ?? { quantidade: 0, exemplos: [], valores: new Set<string>() };

    atual.quantidade += 1;
    if (atual.exemplos.length < 5) atual.exemplos.push(linha);
    if (valor !== undefined && atual.valores.size < 3) {
      atual.valores.add(valor.length > 0 ? valor : "(vazio)");
    }

    this.porMotivo.set(motivo, atual);
  }

  listar(): RejeicaoAgrupada[] {
    return [...this.porMotivo.entries()]
      .map(([motivo, dados]) => ({
        motivo,
        quantidade: dados.quantidade,
        exemplos: dados.exemplos,
        amostraDeValores: [...dados.valores],
      }))
      .sort((a, b) => b.quantidade - a.quantidade);
  }
}

interface Acumulada {
  sessionId: string;
  mensagens: MessageSnapshot[];
  contatoId?: string;
  contatoNome?: string;
  telefone?: string;
  canal?: string;
  atendenteId?: string;
  atendenteNome?: string;
}

export function normalizarPlanilha(
  linhas: LinhaDaPlanilha[],
  opcoes: OpcoesDeNormalizacao,
): ResultadoDaNormalizacao {
  const { mapeamento, direcoes, accountId } = opcoes;
  const rejeicoes = new Rejeicoes();
  const avisos: string[] = [];

  const colunaSessao = mapeamento.sessionId;
  const colunaTexto = mapeamento.texto;
  const colunaDirecao = mapeamento.direcao;
  const colunaData = mapeamento.dataHora;

  if (!colunaSessao || !colunaTexto || !colunaDirecao || !colunaData) {
    return {
      conversas: [],
      contatos: [],
      mensagens: 0,
      rejeicoes: [
        {
          motivo:
            "O mapeamento nao define as colunas obrigatorias (atendimento, mensagem, " +
            "direcao e data). Volte ao passo de mapeamento.",
          quantidade: linhas.length,
          exemplos: [],
          amostraDeValores: [],
        },
      ],
      avisos,
    };
  }

  const ler = (linha: LinhaDaPlanilha, coluna?: string): string =>
    coluna ? (linha.valores[coluna] ?? "").trim() : "";

  const porSessao = new Map<string, Acumulada>();

  for (const linha of linhas) {
    // Link do atendimento vira o id que ele carrega: senao a URL inteira
    // seria o id, e a mesma conversa nao casaria com a busca pela API.
    const brutoSessao = ler(linha, colunaSessao);
    const sessionId = extrairIdDaSessao(brutoSessao) ?? brutoSessao;
    if (!sessionId) {
      rejeicoes.registrar("Sem identificador de atendimento.", linha.numero);
      continue;
    }

    const texto = ler(linha, colunaTexto);
    if (!texto) {
      // Anexo sem legenda, evento de sistema, linha de separacao. Nao e erro,
      // mas tambem nao alimenta a analise — e precisa aparecer na contagem.
      rejeicoes.registrar("Sem texto na mensagem (anexo ou evento).", linha.numero);
      continue;
    }

    const brutaDirecao = ler(linha, colunaDirecao);
    const direction = direcoes[brutaDirecao];
    if (!direction) {
      rejeicoes.registrar("Direcao nao reconhecida.", linha.numero, brutaDirecao);
      continue;
    }

    const brutaData = ler(linha, colunaData);
    const quando = interpretarData(brutaData);
    if (quando === null) {
      rejeicoes.registrar("Data ilegivel.", linha.numero, brutaData);
      continue;
    }

    const acumulada = porSessao.get(sessionId) ?? { sessionId, mensagens: [] };

    acumulada.mensagens.push({
      // A linha da planilha e o id: estavel, unico e rastreavel de volta ao
      // arquivo quando alguem for conferir uma evidencia.
      id: `linha-${linha.numero}`,
      sessionId,
      direction,
      text: texto,
      sentAt: new Date(quando).toISOString(),
    });

    // Dados do contato e do atendente: vale o primeiro preenchido da conversa.
    acumulada.contatoId ??= ler(linha, mapeamento.contatoId) || undefined;
    acumulada.contatoNome ??= ler(linha, mapeamento.contatoNome) || undefined;
    acumulada.telefone ??= ler(linha, mapeamento.telefone) || undefined;
    acumulada.canal ??= ler(linha, mapeamento.canal) || undefined;
    acumulada.atendenteId ??= ler(linha, mapeamento.atendenteId) || undefined;
    acumulada.atendenteNome ??= ler(linha, mapeamento.atendenteNome) || undefined;

    porSessao.set(sessionId, acumulada);
  }

  const conversas: ConversationSnapshot[] = [];
  const contatosPorId = new Map<string, ContactSnapshot>();
  let mensagens = 0;
  let semIdentidade = 0;
  let provisorias = 0;

  for (const acumulada of porSessao.values()) {
    // A ordem da planilha nao e garantida; a analise depende da cronologia.
    const ordenadas = [...acumulada.mensagens].sort(
      (a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt),
    );

    const primeira = ordenadas[0];
    const ultima = ordenadas[ordenadas.length - 1];
    if (!primeira || !ultima) continue;

    const digitos = acumulada.telefone ? apenasDigitos(acumulada.telefone) : "";

    const contactId =
      acumulada.contatoId ??
      (digitos ? `${PREFIXO_TELEFONE}${digitos}` : "");

    if (!contactId) semIdentidade += 1;
    else if (identidadeProvisoria(contactId)) provisorias += 1;

    if (contactId && !contatosPorId.has(contactId)) {
      contatosPorId.set(contactId, {
        id: contactId,
        accountId,
        name: acumulada.contatoNome ?? "Contato sem nome",
        tagIds: [],
        createdAt: primeira.sentAt,
        updatedAt: ultima.sentAt,
        ...(acumulada.telefone ? { phone: acumulada.telefone } : {}),
      });
    }

    const entradas = ordenadas.filter((m) => m.direction === "INBOUND");
    const saidas = ordenadas.filter((m) => m.direction === "OUTBOUND");

    mensagens += ordenadas.length;

    conversas.push({
      id: acumulada.sessionId,
      accountId,
      contactId,
      channel: normalizeChannel(acumulada.canal),
      // O relatorio nao diz se o atendimento segue aberto. OPEN e o unico
      // palpite que nao esconde uma oportunidade viva.
      status: "OPEN",
      startedAt: primeira.sentAt,
      lastMessageAt: ultima.sentAt,
      messages: ordenadas,
      ...(acumulada.atendenteId ? { agentId: acumulada.atendenteId } : {}),
      ...(acumulada.atendenteNome ? { agentName: acumulada.atendenteNome } : {}),
      ...(entradas.length > 0
        ? { lastInboundAt: entradas[entradas.length - 1]?.sentAt }
        : {}),
      ...(saidas.length > 0 ? { lastOutboundAt: saidas[saidas.length - 1]?.sentAt } : {}),
    });
  }

  conversas.sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));

  if (provisorias > 0) {
    avisos.push(
      `${provisorias} conversa(s) foram identificadas pelo TELEFONE porque o ` +
        `relatorio nao traz o id do contato. Da para analisar; para etiquetar ou ` +
        `criar card, o contato precisa ser resolvido na plataforma antes.`,
    );
  }

  if (semIdentidade > 0) {
    avisos.push(
      `${semIdentidade} conversa(s) ficaram sem id de contato e sem telefone. ` +
        `Elas aparecem na analise, mas nao ha como escrever de volta nelas.`,
    );
  }

  if (!mapeamento.atendenteId && !mapeamento.atendenteNome) {
    avisos.push(
      "Nenhuma coluna de atendente foi mapeada: o relatorio de qualidade por " +
        "atendente vai sair vazio.",
    );
  }

  return { conversas, contatos: [...contatosPorId.values()], mensagens, rejeicoes: rejeicoes.listar(), avisos };
}
