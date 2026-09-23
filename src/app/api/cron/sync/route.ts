import { after, NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { apagarConversasAntigas, rodarSincronizacao } from "@/lib/sync/controle";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Limite de rodadas encadeadas por disparo do cron. */
const MAX_RODADAS = 40;

/**
 * Cron diário da Vercel (vercel.json). No plano Hobby o cron roda 1x/dia e cada
 * função tem 60s, então a rota faz uma rodada e, se não terminou, dispara a
 * próxima chamada para si mesma (encadeamento), até concluir.
 */
export async function GET(request: NextRequest) {
  try {
    return await cron(request);
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

async function cron(request: NextRequest) {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || request.headers.get("authorization") !== `Bearer ${segredo}`) {
    return NextResponse.json({ erro: "não autorizado" }, { status: 401 });
  }

  const rodada = Number(request.nextUrl.searchParams.get("rodada") ?? "1");
  let apagadas: number | undefined;
  const dias = env().RETENCAO_DIAS;
  if (rodada === 1 && dias) apagadas = await apagarConversasAntigas(dias);

  const resultado = await rodarSincronizacao("cron");

  if (!resultado.concluido && !resultado.ocupado && rodada < MAX_RODADAS) {
    const proxima = new URL(request.nextUrl);
    proxima.searchParams.set("rodada", String(rodada + 1));
    after(async () => {
      // Só precisamos que a próxima chamada comece; não esperamos ela terminar.
      await fetch(proxima, {
        headers: { authorization: `Bearer ${segredo}` },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    });
  }

  return NextResponse.json({ rodada, apagadas, ...resultado });
}
