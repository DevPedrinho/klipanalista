import { IntelligenceCenter } from "@/components/intelligence/IntelligenceCenter";
import { MissingParams } from "@/components/intelligence/MissingParams";
import { SeletorDeUsuario } from "@/components/intelligence/SeletorDeUsuario";
import { getIntegrationReadiness } from "@/server/config/env";
import { agentsAdapter } from "@/server/integration/adapters";

/**
 * Central de Inteligência Comercial.
 *
 * Rota destinada a ser incorporada como página interna em um menu
 * personalizado da KlipFlowi. Os parâmetros chegam pela URL e são validados
 * aqui (formato) e no servidor (existência e permissão).
 *
 * Aberta fora da KlipFlowi — digitando o endereço, que é o que qualquer
 * pessoa faz — não há parâmetro nenhum. Nesse caso a página pergunta quem
 * está usando, em vez de exigir que se conheça um id de cor.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface PageProps {
  // No Next 16 os searchParams são assíncronos.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = params[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Mesmo formato aceito pelo servidor: evita ida e volta desnecessária. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;

  // Aceita tenantId como alternativa a accountId, conforme o briefing.
  const accountIdInformado =
    readParam(params, "accountId") ?? readParam(params, "tenantId");
  const userId = readParam(params, "userId");

  const integracao = getIntegrationReadiness();

  /*
   * Sem integração real não há a quem perguntar: o conjunto simulado tem
   * ids próprios, e a tela de parâmetros faltando continua sendo a resposta
   * certa — ela explica o que a KlipFlowi precisa enviar.
   */
  if (!integracao.ready) {
    const missing: string[] = [];
    if (!accountIdInformado) missing.push("accountId (ou tenantId)");
    if (!userId) missing.push("userId");

    if (missing.length > 0) return <MissingParams missing={missing} context="central" />;
  }

  if (accountIdInformado && !ID_PATTERN.test(accountIdInformado)) {
    return (
      <MissingParams
        missing={["accountId deve conter apenas letras, números, hífen e underscore"]}
        context="central"
      />
    );
  }

  if (userId && !ID_PATTERN.test(userId)) {
    return (
      <MissingParams
        missing={["userId deve conter apenas letras, números, hífen e underscore"]}
        context="central"
      />
    );
  }

  /*
   * Em modo real, o token é que define a conta — o accountId da URL é apenas
   * o rótulo usado na auditoria e no isolamento interno. Quando ele não vem,
   * usamos o id que a própria API informa (`companyId`), em vez de inventar
   * um nome de conta que não corresponde a nada.
   */
  const usuarios = await agentsAdapter.list({
    accountId: accountIdInformado ?? "conta",
  });

  const accountId =
    accountIdInformado ?? usuarios.data[0]?.apiAccountId ?? "conta";

  const escolhido = userId
    ? usuarios.data.find((u) => u.id === userId)
    : undefined;

  if (!escolhido) {
    // Os usuários precisam carregar o rótulo final de conta, senão o link
    // levaria a uma página que rejeitaria o próprio usuário que ela ofereceu.
    const comRotulo = usuarios.data.map((u) => ({ ...u, accountId }));

    return (
      <SeletorDeUsuario
        accountId={accountId}
        usuarios={comRotulo}
        motivo={userId ? "USUARIO_NAO_ENCONTRADO" : "SEM_PARAMETRO"}
        {...(userId ? { userIdInformado: userId } : {})}
      />
    );
  }

  return <IntelligenceCenter accountId={accountId} userId={escolhido.id} />;
}
