import { NextResponse, type NextRequest } from "next/server";

/**
 * Acesso ao app. A KlipFlowi abre o app (menu personalizado) com `?accountId=...`.
 * - `accountId` precisa ser igual a FLW_ACCOUNT_ID;
 * - se APP_CHAVE_ACESSO estiver definida, `?chave=` também precisa bater
 *   (recomendado: o accountId sozinho não é segredo).
 * Validado uma vez, vira um cookie (particionado, funciona dentro do iframe).
 */
const COOKIE = "klip_acesso";

async function assinatura(): Promise<string | null> {
  const conta = process.env.FLW_ACCOUNT_ID;
  if (!conta) return null;
  const segredo = `${conta}|${process.env.APP_CHAVE_ACESSO ?? ""}|${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(segredo));
  return Buffer.from(hash).toString("base64url");
}

export async function proxy(request: NextRequest) {
  const esperado = await assinatura();
  if (!esperado) {
    // Sem FLW_ACCOUNT_ID só liberamos em desenvolvimento.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return negar(request, "FLW_ACCOUNT_ID não configurado no servidor.");
  }

  if (request.cookies.get(COOKIE)?.value === esperado) return NextResponse.next();

  const url = request.nextUrl;
  const conta = url.searchParams.get("accountId") ?? url.searchParams.get("tenantId");
  const chave = url.searchParams.get("chave") ?? "";
  const chaveOk = !process.env.APP_CHAVE_ACESSO || chave === process.env.APP_CHAVE_ACESSO;

  if (conta === process.env.FLW_ACCOUNT_ID && chaveOk) {
    const resposta = NextResponse.next();
    const producao = process.env.NODE_ENV === "production";
    resposta.cookies.set(COOKIE, esperado, {
      httpOnly: true,
      secure: producao,
      sameSite: producao ? "none" : "lax",
      partitioned: producao,
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return resposta;
  }

  return negar(request, "Acesso não autorizado. Abra o Klip Analista pelo menu da KlipFlowi.");
}

function negar(request: NextRequest, mensagem: string) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ erro: mensagem }, { status: 401 });
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Klip Analista</title><body style="font-family:system-ui;padding:2rem;color:#333"><h1 style="font-size:1.2rem">Klip Analista</h1><p>${mensagem}</p></body>`,
    { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export const config = {
  // O cron tem autenticação própria (CRON_SECRET).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api/cron).*)"],
};
