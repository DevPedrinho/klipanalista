import "server-only";
import { z } from "zod";
import type { UserRole } from "@/domain/enums";
import type { AppUser, PeriodFilter, TenantContext, WidgetContext } from "@/domain/types";

/**
 * Validacao de parametros e montagem do contexto de tenant.
 *
 * PROTECAO CONTRA IDOR: o accountId e o userId chegam pela URL (a KlipFlowi
 * os injeta ao abrir a pagina no menu personalizado). Nunca confiamos neles
 * cegamente:
 *   1. o formato e validado;
 *   2. o usuario e resolvido contra a base de usuarios DA CONTA informada;
 *   3. o perfil vem do cadastro, NUNCA da URL;
 *   4. o escopo de visibilidade e derivado do perfil resolvido.
 *
 * Assim, trocar o userId na barra de enderecos nao concede acesso: o perfil
 * e o escopo continuam sendo os do usuario realmente cadastrado.
 *
 * PENDENTE DE VALIDACAO: esta versao confia que a KlipFlowi so abre a pagina
 * para usuarios ja autenticados na plataforma. Antes de producao, assine os
 * parametros (HMAC com validade curta) ou valide o usuario via login
 * integrado, para que a URL nao possa ser forjada.
 */

/** Ids da plataforma: alfanumericos, hifen, underscore. Sem path traversal. */
const idSchema = z
  .string()
  .min(1, "obrigatorio")
  .max(128, "muito longo")
  .regex(/^[A-Za-z0-9_-]+$/, "formato invalido");

const isoDateSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "data invalida");

export const baseParamsSchema = z.object({
  accountId: idSchema,
  userId: idSchema,
});

export const periodSchema = z
  .object({
    preset: z.enum(["3d", "7d", "15d", "30d", "90d", "custom"]).default("3d"),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine(
    (value) => value.preset !== "custom" || (Boolean(value.from) && Boolean(value.to)),
    { message: "Periodo personalizado exige `from` e `to`." },
  );

export const filtersSchema = z.object({
  accountId: idSchema,
  userId: idSchema,
  preset: z.enum(["3d", "7d", "15d", "30d", "90d", "custom"]).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  teamId: idSchema.optional(),
  agentId: idSchema.optional(),
  priority: z.enum(["CRITICA", "ALTA", "MEDIA", "BAIXA"]).optional(),
  search: z.string().max(200).optional(),
});

export const widgetParamsSchema = z.object({
  accountId: idSchema,
  userId: idSchema,
  contactId: idSchema.optional(),
  sessionId: idSchema.optional(),
  cardId: idSchema.optional(),
  origin: z.enum(["atendimento", "crm"]).default("atendimento"),
});

/** Converte um preset em janela de datas concreta. */
export function resolvePeriod(params: {
  preset?: string;
  from?: string;
  to?: string;
  now?: Date;
}): PeriodFilter {
  const now = params.now ?? new Date();
  /*
   * Tres dias por padrao.
   *
   * A API nao aceita filtro de data e entrega a listagem da conversa mais
   * ANTIGA para a mais nova, com 22 mil conversas nesta conta. Cada dia a
   * mais no recorte custa paginas lidas de tras para frente. Tres dias e a
   * janela em que uma oportunidade ainda esta quente e cabe inteira no
   * orcamento de tempo — periodos maiores continuam disponiveis, so custam
   * mais.
   */
  const preset = (params.preset ?? "3d") as PeriodFilter["preset"];

  if (preset === "custom" && params.from && params.to) {
    return { preset: "custom", from: params.from, to: params.to };
  }

  const days =
    preset === "3d" ? 3
    : preset === "7d" ? 7
    : preset === "15d" ? 15
    : preset === "90d" ? 90
    : 30;
  const from = new Date(now.getTime() - days * 24 * 36e5);

  return {
    preset: preset === "custom" ? "3d" : preset,
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

export class AccessError extends Error {
  readonly code: "SEM_PERMISSAO" | "NAO_AUTENTICADO" | "USUARIO_NAO_ENCONTRADO";
  constructor(code: AccessError["code"], message: string) {
    super(message);
    this.name = "AccessError";
    this.code = code;
  }
}

/**
 * Deriva o escopo de visibilidade a partir do PERFIL CADASTRADO.
 *
 * VENDEDOR -> apenas os proprios atendimentos.
 * GESTOR   -> os atendimentos da propria equipe.
 * ADMIN    -> toda a conta.
 */
export function resolveVisibility(
  user: AppUser,
  allUsers: AppUser[],
): TenantContext["visibleAgentIds"] {
  if (user.role === "ADMIN") return "ALL";

  if (user.role === "GESTOR") {
    // Um atendente pode estar em varias equipes (a API devolve `departments`
    // como lista). O gestor enxerga quem compartilha QUALQUER uma das suas.
    const equipesDoGestor = new Set(user.teamIds ?? (user.teamId ? [user.teamId] : []));
    if (equipesDoGestor.size === 0) return [user.id];

    return allUsers
      .filter((u) => {
        const equipes = u.teamIds ?? (u.teamId ? [u.teamId] : []);
        return equipes.some((equipe) => equipesDoGestor.has(equipe));
      })
      .map((u) => u.id);
  }

  return [user.id];
}

/**
 * Monta o contexto de tenant a partir dos parametros recebidos.
 *
 * `allUsers` deve vir da conta informada — e o que impede que um userId de
 * outra conta seja aceito.
 */
export function buildTenantContext(params: {
  accountId: string;
  userId: string;
  allUsers: AppUser[];
  requestedTeamId?: string;
}): TenantContext {
  const user = params.allUsers.find(
    (u) => u.id === params.userId && u.accountId === params.accountId,
  );

  if (!user) {
    throw new AccessError(
      "USUARIO_NAO_ENCONTRADO",
      "Usuario nao encontrado nesta conta. O token esta valendo; o que nao confere " +
        "e o userId informado na URL.",
    );
  }

  if (!user.active) {
    throw new AccessError("SEM_PERMISSAO", "Usuario inativo nesta conta.");
  }

  const visibleAgentIds = resolveVisibility(user, params.allUsers);

  // Um vendedor nao pode pedir o recorte de outra equipe.
  if (params.requestedTeamId && user.role === "VENDEDOR") {
    throw new AccessError(
      "SEM_PERMISSAO",
      "Seu perfil permite ver apenas os proprios atendimentos.",
    );
  }

  return {
    accountId: params.accountId,
    userId: user.id,
    role: user.role,
    visibleAgentIds,
    teamId: params.requestedTeamId ?? user.teamId,
  };
}

/** Confere se o contexto pode enxergar um atendimento de um dado agente. */
export function canSeeAgent(context: TenantContext, agentId?: string): boolean {
  if (context.visibleAgentIds === "ALL") return true;
  if (!agentId) return true; // conversa sem responsavel e visivel a todos
  return context.visibleAgentIds.includes(agentId);
}

/** Perfis autorizados a aprovar acoes sensiveis. */
export function canApproveActions(role: UserRole): boolean {
  return role === "GESTOR" || role === "ADMIN";
}

/** Apenas administradores mexem nas configuracoes de automacao. */
export function canEditSettings(role: UserRole): boolean {
  return role === "ADMIN";
}

export function buildWidgetContext(input: z.infer<typeof widgetParamsSchema>): WidgetContext {
  return {
    accountId: input.accountId,
    userId: input.userId,
    contactId: input.contactId,
    sessionId: input.sessionId,
    cardId: input.cardId,
    origin: input.origin,
  };
}
