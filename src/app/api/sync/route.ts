import { NextResponse } from "next/server";
import { rodarSincronizacao } from "@/lib/sync/controle";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Uma rodada da sincronização. O botão "Sincronizar agora" chama em loop até `concluido`. */
export async function POST() {
  try {
    const resultado = await rodarSincronizacao("manual");
    return NextResponse.json(resultado, { status: resultado.ocupado ? 409 : 200 });
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
