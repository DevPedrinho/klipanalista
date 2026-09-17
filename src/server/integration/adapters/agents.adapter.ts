import "server-only";
import type { UserRole } from "@/domain/enums";
import type { AppUser, Team } from "@/domain/types";
import { MOCK_TEAMS, MOCK_USERS, findUser } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequestAllPages } from "../http/client";
import {
  MappingReport,
  readArray,
  readBoolean,
  readIdList,
  readString,
} from "../mappers/tolerant";
import { liveResult, mockResult, shouldUseMock, type AdapterResult } from "./base";

/**
 * AgentsAdapter — usuarios (atendentes) e equipes (departamentos).
 *
 * Endpoints CONFIRMADOS:
 *   GET /v1/agent                    Listar usuarios
 *   GET /v1/agent/{id}               Obter por ID
 *   GET /v2/department               Listar equipes
 *   GET /v1/department/{id}          Obter equipe
 *
 * PERFIL — CONFIRMADO pela sonda contra a conta real: vem no campo
 * `profile`, com os valores ADMIN e AGENT, e o dono da conta e marcado em
 * `isOwner`. A conta sondada nao possui nenhum perfil intermediario, entao
 * a deteccao de GESTOR continua por palavra-chave e ainda nao foi vista em
 * dado real. Qualquer valor desconhecido cai em VENDEDOR — o perfil MENOS
 * privilegiado. Errar para o lado restritivo e proposital.
 */

function normalizeRole(raw?: string, isAdmin?: boolean): UserRole {
  if (isAdmin === true) return "ADMIN";

  const upper = (raw ?? "").toUpperCase();
  if (upper.includes("ADMIN") || upper.includes("OWNER")) return "ADMIN";
  if (upper.includes("MANAG") || upper.includes("GEST") || upper.includes("SUPERV")) return "GESTOR";

  // Padrao deliberadamente restritivo.
  return "VENDEDOR";
}

/**
 * Primeira equipe do usuario.
 *
 * CONFIRMADO pela sonda contra a conta real: o payload de /v1/agent traz
 * `departments` — uma LISTA — e nao `departmentId`. Enquanto este mapeador
 * procurava `departmentId`, TODO usuario ficava sem equipe, e o escopo de
 * visibilidade de um gestor silenciosamente encolhia para "apenas os
 * proprios atendimentos". Um gestor via menos do que devia sem nenhum aviso.
 *
 * Um usuario pode pertencer a varias equipes; usamos a primeira como equipe
 * principal e guardamos o resto em `teamIds`.
 */
function readDepartments(
  raw: unknown,
  report: MappingReport,
): { ids: string[]; firstName?: string } {
  const lista = readArray(raw, ["departments", "teams"], "agent.departments", report);

  const ids: string[] = [];
  let firstName: string | undefined;

  for (const item of lista) {
    // A lista pode vir como objetos {id, name} ou como ids soltos.
    if (typeof item === "string") {
      ids.push(item);
      continue;
    }
    const id = readString(item, ["id", "departmentId"], "agent.department.id");
    if (!id) continue;
    ids.push(id);
    if (!firstName) firstName = readString(item, ["name", "title"], "agent.department.name");
  }

  return firstName === undefined ? { ids } : { ids, firstName };
}

export function mapAgent(raw: unknown, accountId: string, report: MappingReport): AppUser | null {
  const id = readString(raw, ["id", "agentId", "userId", "uuid"], "agent.id", report);
  if (!id) return null;

  const departments = readDepartments(raw, report);

  return {
    id,
    accountId,
    name: readString(raw, ["name", "fullName", "displayName"], "agent.name", report) ?? "Usuario",
    email: readString(raw, ["email", "mail"], "agent.email", report),
    role: normalizeRole(
      // CONFIRMADO: a API usa `profile`, com os valores ADMIN e AGENT.
      readString(raw, ["profile", "role", "type", "permission"], "agent.profile", report),
      // CONFIRMADO: o dono da conta vem em `isOwner`, nao em `isAdmin`.
      readBoolean(raw, ["isOwner", "isAdmin", "admin"], "agent.isOwner", report),
    ),
    teamId: departments.ids[0],
    teamIds: departments.ids,
    teamName: departments.firstName,
    active: readBoolean(raw, ["active", "enabled", "isActive"], "agent.active", report) ?? true,
  };
}

export function mapDepartment(raw: unknown, accountId: string, report: MappingReport): Team | null {
  const id = readString(raw, ["id", "departmentId", "uuid"], "department.id", report);
  if (!id) return null;

  return {
    id,
    accountId,
    name: readString(raw, ["name", "title"], "department.name", report) ?? "Equipe",
    memberIds: readIdList(raw, ["agents", "users", "members", "agentIds"], "department.memberIds", report),
  };
}

export const agentsAdapter = {
  async list(params: { accountId: string }): Promise<AdapterResult<AppUser[]>> {
    if (shouldUseMock()) {
      return mockResult(MOCK_USERS.filter((u) => u.accountId === params.accountId));
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(ENDPOINTS.AGENTS.LIST, {}, {}, 5);

    const users = raw
      .map((item) => mapAgent(item, params.accountId, report))
      .filter((u): u is AppUser => u !== null);

    return liveResult(users, report, "Usuario");
  },

  async getById(params: {
    accountId: string;
    userId: string;
  }): Promise<AdapterResult<AppUser | null>> {
    if (shouldUseMock()) {
      const found = findUser(params.userId);
      return mockResult(found && found.accountId === params.accountId ? found : null);
    }

    const all = await agentsAdapter.list(params);
    return { ...all, data: all.data.find((u) => u.id === params.userId) ?? null };
  },

  async listTeams(params: { accountId: string }): Promise<AdapterResult<Team[]>> {
    if (shouldUseMock()) {
      return mockResult(MOCK_TEAMS.filter((t) => t.accountId === params.accountId));
    }

    const report = new MappingReport();
    const raw = await apiRequestAllPages<unknown>(ENDPOINTS.DEPARTMENTS.LIST, {}, {}, 5);

    const teams = raw
      .map((item) => mapDepartment(item, params.accountId, report))
      .filter((t): t is Team => t !== null);

    return liveResult(teams, report, "Equipe");
  },
};
