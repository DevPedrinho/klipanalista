import { NextResponse } from "next/server";
import { api, db } from "@/lib/servidor";
import { erroJson } from "@/lib/respostas";

export const dynamic = "force-dynamic";

/** Painéis do CRM (lidos da API e guardados em cache). */
export async function GET() {
  try {
    const paineis = await api().listarPaineis();
    const rows = paineis.map((p) => {
      const r = p as Record<string, unknown>;
      return { id: String(r.id), title: (r.title as string) ?? null, type: (r.type as string) ?? null, raw: p };
    });
    if (rows.length > 0) {
      const { error } = await db().from("crm_panels").upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })));
      if (error) throw new Error(`Supabase: ${error.message}`);
    }
    return NextResponse.json({
      paineis: rows
        .map(({ id, title, type }) => ({ id, title, type }))
        // Painéis de vendas primeiro.
        .sort((a, b) => Number(b.type === "SALES") - Number(a.type === "SALES")),
    });
  } catch (e) {
    return erroJson(e);
  }
}
