import "server-only";
import type { UserRole } from "@/domain/enums";
import type { AppUser, Team } from "@/domain/types";
import { MOCK_TEAMS, MOCK_USERS, findUser } from "@/mocks/dataset";
import { ENDPOINTS } from "../endpoints";
import { apiRequestAllPages } from "../http/client";
import { MappingReport, readBoolean, readIdList, readString } from "../mappers/tolerant";
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
 * PENDENTE DE VALIDACAO: como o PERFIL (vendedor/gestor/admin) e
 * representado. A normalizacao abaixo procura indicios no payload e cai em
 * VENDEDOR — o perfil MENOS privilegiado — quando nao ha certeza.
 * Errar para o lado restritivo e proposital.
 */

function normalizeRole(raw?: string, isAdmin?: boolean): UserRole {
  if (isAdmin === true) return "ADMIN";

  const upper = (raw ?? "").toUpperCase();
  if (upper.includes("ADMIN") || upper.includes("OWNER")) return "ADMIN";
  if (upper.includes("MANAG") || upper.includes("GEST") || upper.includes("SUPERV")) return "GESTOR";

  // Padrao deliberadamente restritivo.
  return "VENDEDOR";
}

export function mapAgent(raw: unknown, accountId: string, report: MappingReport): AppUser | null {
  const id = readString(raw, ["id", "agentId", "userId", "uuid"], "agent.id", report);
  if (!id) return null;

  return {
    id,
    accountId,
    name: readString(raw, ["name", "fullName", "displayName"], "agent.name", report) ?? "Usuario",
    email: readString(raw, ["email", "mail"], "agent.email", report),
    role: normalizeRole(
      readString(raw, ["role", "profile", "type", "permission"], "agent.role", report),
      readBoolean(raw, ["isAdmin", "admin"], "agent.isAdmin", report),
    ),
    teamId: readString(raw, ["departmentId", "teamId"], "agent.teamId", report),
    teamName: readString(raw, ["departmentName", "teamName"], "agent.teamName", report),
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
