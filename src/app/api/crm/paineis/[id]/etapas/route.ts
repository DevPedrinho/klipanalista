import { NextResponse } from "next/server";
import { etapasDosCards } from "@/lib/klipflowi/mappers";
import { api, db } from "@/lib/servidor";
import { erroJson } from "@/lib/respostas";

export const dynamic = "force-dynamic";

/** Etapas do painel, deduzidas dos cards (a API devolve `steps` nulo). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const etapas = etapasDosCards(await api().listarCardsDoPainel(id));
    await db().from("crm_panels").update({ steps: etapas }).eq("id", id);
    return NextResponse.json({ etapas });
  } catch (e) {
    return erroJson(e);
  }
}
