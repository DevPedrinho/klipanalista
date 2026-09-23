import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/servidor";
import { apagarConversasAntigas } from "@/lib/sync/controle";

export const dynamic = "force-dynamic";

const entrada = z.discriminatedUnion("modo", [
  z.object({ modo: z.literal("antigas"), dias: z.number().int().positive(), confirmacao: z.literal("APAGAR") }),
  z.object({ modo: z.literal("tudo"), confirmacao: z.literal("APAGAR") }),
]);

/**
 * Libera espaço no banco. Apaga SÓ dados do schema `klip` deste app —
 * nada é apagado na KlipFlowi.
 */
export async function POST(request: Request) {
  const parsed = entrada.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ erro: "Confirme digitando APAGAR" }, { status: 400 });
  }

  try {
    if (parsed.data.modo === "antigas") {
      const apagadas = await apagarConversasAntigas(parsed.data.dias);
      return NextResponse.json({ apagadas });
    }

    const banco = db();
    // Ordem respeita as chaves estrangeiras; mensagens caem em cascata com as conversas.
    const tabelas = ["crm_card_notes", "crm_cards", "sessions", "contacts", "agents", "crm_panels"] as const;
    for (const tabela of tabelas) {
      const { error } = await banco.from(tabela).delete().not("id", "is", null);
      if (error) throw new Error(`Supabase (${tabela}): ${error.message}`);
    }
    const { error } = await banco.from("sync_runs").delete().gte("id", 0);
    if (error) throw new Error(`Supabase (sync_runs): ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
