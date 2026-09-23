import { type NextRequest } from "next/server";
import { z } from "zod";
import { agentsAdapter, panelsAdapter, tagsAdapter } from "@/server/integration/adapters";
import { getIntegrationReadiness } from "@/server/config/env";
import { failValidation, handleError, ok } from "@/server/http/respond";
import { analisarConjunto } from "@/server/services/intelligence.service";
import { buscarConversasPorId } from "@/server/services/busca-por-id.service";
import { getSettings } from "@/server/services/settings.service";
import { buildTenantContext, resolvePeriod } from "@/server/security/tenant-context";
import type { ContactSnapshot, ConversationSnapshot } from "@/domain/types";

/**
 * POST /api/intelligence/analisar-lote
 *
 * Analisa um punhado de atendimentos e devolve as oportunidades daquele
 * punhado. Aceita duas entradas:
 *
 *   `sessionIds` — o caminho principal. Os ids sairam da planilha (a coluna
 *   com o link do atendimento), e cada conversa e buscada na API por id, com
 *   transcricao de audio, direcao e contato de verdade. A resposta traz um
 *   veredito por id, para o navegador saber o que repetir.
 *
 *   `conversas` — o caminho reserva, quando nao ha como buscar na API: as
 *   conversas ja vem montadas da propria planilha.
 *
 * POR QUE EM LOTES, DIRIGIDO PELO NAVEGADOR
 *
 * Um relatorio traz centenas de conversas, e a leitura por IA de cada uma leva
 * segundos. Isso nao cabe nos 60 segundos da plataforma. Tambem nao da para
 * guardar o progresso no servidor: auditoria e configuracoes vivem em memoria
 * e somem no cold start.
 *
 * Entao o navegador segura as conversas e pede a analise aos poucos,
 * mostrando o progresso. O servidor fica sem estado — cada chamada se basta.
 * O preco e assumido e dito na tela: fechar a aba perde o andamento.
 *
 * O QUE ESTA ROTA LE DA API
 *
 * Sempre o cadastro: etiquetas, paineis e usuarios. Sao listas pequenas e
 * indispensaveis — sem as etiquetas da conta nao ha o que sugerir, e sem os
 * usuarios nao ha escopo de visibilidade. No caminho por id, tambem cada
 * conversa e o contato dela.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Teto de conversas por chamada.
 *
 * Acima disso a leitura por IA do lote passa do tempo da plataforma. O
 * navegador quebra a lista neste tamanho; o teto aqui e a rede de seguranca.
 */
export const MAX_POR_LOTE = 25;

/**
 * Teto de ids por chamada, no caminho que busca na API.
 *
 * Menor que `MAX_POR_LOTE` porque aqui a mesma chamada ainda BUSCA: cada id
 * custa ao menos tres requisicoes (conversa, mensagens, contato), que passam
 * pelo limitador de vazao antes de a IA comecar a ler.
 */
export const MAX_IDS_POR_LOTE = 20;

/**
 * Quanto da chamada pode ir para a busca na API.
 *
 * O resto e da leitura por IA, que tem o proprio orcamento (35 s). Somados
 * ficam abaixo dos 60 s da plataforma. O que nao couber volta como
 * `NAO_INICIADA` e entra no proximo lote — nada se perde.
 */
const TEMPO_DE_BUSCA_MS = 15_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mensagemSchema = z.object({
  id: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  direction: z.enum(["INBOUND", "OUTBOUND"]),
  text: z.string().max(20_000),
  sentAt: z.string().max(40),
  transcrito: z.boolean().optional(),
});

const conversaSchema = z.object({
  id: z.string().min(1).max(200),
  accountId: z.string().min(1).max(128),
  contactId: z.string().max(200),
  channel: z.enum([
    "WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM", "EMAIL", "WEBCHAT", "SMS", "OUTRO",
  ]),
  status: z.enum(["OPEN", "CLOSED", "PENDING"]),
  startedAt: z.string().max(40),
  lastMessageAt: z.string().max(40),
  messages: z.array(mensagemSchema).max(2_000),
  agentId: z.string().max(200).optional(),
  agentName: z.string().max(200).optional(),
  lastInboundAt: z.string().max(40).optional(),
  lastOutboundAt: z.string().max(40).optional(),
});

const contatoSchema = z.object({
  id: z.string().min(1).max(200),
  accountId: z.string().min(1).max(128),
  name: z.string().max(300),
  tagIds: z.array(z.string().max(200)).max(200),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  phone: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
});

const bodySchema = z
  .object({
    accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    conversas: z.array(conversaSchema).min(1).max(MAX_POR_LOTE).optional(),
    contatos: z.array(contatoSchema).max(MAX_POR_LOTE * 2).default([]),
    /**
     * UUID e nada mais: o id vai para o caminho da URL da API, e aceitar
     * texto livre ali seria abrir a porta para `../` num caminho autenticado.
     */
    sessionIds: z
      .array(z.string().regex(UUID, "Id de atendimento deve ser um UUID."))
      .min(1)
      .max(MAX_IDS_POR_LOTE)
      .optional(),
    /** Desliga a leitura por IA, para comparar os dois motores. */
    semIa: z.boolean().optional(),
  })
  .refine((b) => (b.conversas === undefined) !== (b.sessionIds === undefined), {
    message: "Envie `sessionIds` (buscar na API) ou `conversas` (da planilha), um dos dois.",
  });

export async function POST(request: NextRequest) {
  try {
    const inicio = Date.now();
    const readiness = getIntegrationReadiness();

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return failValidation(parsed.error.issues);

    const input = parsed.data;

    // O perfil e o escopo vem do cadastro da conta, nunca do corpo do pedido.
    const users = await agentsAdapter.list({ accountId: input.accountId });
    const context = buildTenantContext({
      accountId: input.accountId,
      userId: input.userId,
      allUsers: users.data,
    });

    const [tags, panels, busca] = await Promise.all([
      tagsAdapter.list({ accountId: input.accountId }),
      panelsAdapter.list({ accountId: input.accountId }),
      input.sessionIds
        ? buscarConversasPorId({
            accountId: input.accountId,
            sessionIds: input.sessionIds.map((id) => id.toLowerCase()),
            prazo: inicio + TEMPO_DE_BUSCA_MS,
          })
        : null,
    ]);

    const conversas = busca
      ? busca.conversas
      : ((input.conversas ?? []) as ConversationSnapshot[]);
    const contatos = busca ? busca.contatos : (input.contatos as ContactSnapshot[]);

    /*
     * Nenhuma conversa carregada: nao ha o que analisar, mas os vereditos
     * precisam voltar mesmo assim — sao eles que dizem a tela o que repetir.
     */
    if (conversas.length === 0) {
      return ok(
        {
          oportunidades: [],
          conversasRecebidas: 0,
          ...(busca ? { buscas: busca.buscas } : {}),
          sourceFailures: busca?.sourceFailures ?? [],
          pendingValidation: busca?.pendingValidation ?? [],
        },
        { dataMode: readiness.dataMode },
      );
    }

    /*
     * O periodo e derivado das proprias conversas do lote.
     *
     * Quem exportou ja escolheu o recorte; reaplicar um filtro de data aqui so
     * poderia jogar fora conversa que a pessoa pediu para analisar. A janela e
     * esticada em um dia para cada lado para que nenhuma fique na borda.
     */
    const instantes = conversas.map((c) => Date.parse(c.lastMessageAt));
    const validos = instantes.filter((n) => Number.isFinite(n));
    const UM_DIA = 24 * 60 * 60 * 1000;

    const period =
      validos.length > 0
        ? {
            preset: "custom" as const,
            from: new Date(Math.min(...validos) - UM_DIA).toISOString(),
            to: new Date(Math.max(...validos) + UM_DIA).toISOString(),
          }
        : resolvePeriod({ preset: "90d" });

    const overview = await analisarConjunto({
      dados: {
        conversations: conversas,
        contacts: contatos,
        // Cards e funil nao entram por lote: dependem da conta inteira e
        // seriam recalculados a cada chamada, dizendo coisas diferentes a cada
        // vez. O funil continua vindo da Central.
        cards: [],
        panels: panels.data,
        users: users.data,
        tags: tags.data,
        settings: getSettings(input.accountId),
      },
      context,
      filters: { period },
      ...(input.semIa === undefined ? {} : { semIa: input.semIa }),
      ...(busca
        ? { coleta: { sourceFailures: [...busca.sourceFailures], pending: busca.pendingValidation } }
        : {}),
    });

    return ok(
      {
        oportunidades: overview.opportunities,
        conversasRecebidas: conversas.length,
        ...(busca ? { buscas: busca.buscas } : {}),
        ...(overview.aiStats ? { aiStats: overview.aiStats } : {}),
        sourceFailures: overview.sourceFailures,
        pendingValidation: overview.pendingValidation,
      },
      { dataMode: readiness.dataMode },
    );
  } catch (error) {
    return handleError(error);
  }
}
