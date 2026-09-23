import { NextResponse } from "next/server";
import { z } from "zod";
import { api, db } from "@/lib/servidor";
import { erroJson } from "@/lib/respostas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Anotações do card, lidas da KlipFlowi. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const notas = await api().listarAnotacoes(id);
    return NextResponse.json({
      anotacoes: notas.map((n) => {
        const r = n as Record<string, unknown>;
        return {
          id: String(r.id ?? ""),
          texto: (r.text ?? r.content ?? r.note ?? "") as string,
          criadaEm: (r.createdAt ?? null) as string | null,
          autor: ((r.user as Record<string, unknown> | undefined)?.name ?? r.userName ?? null) as string | null,
        };
      }),
    });
  } catch (e) {
    return erroJson(e);
  }
}

const entrada = z.object({ texto: z.string().trim().min(1).max(5000), sessionId: z.string().optional() });

/** Cria uma anotação no card. */
export async function POST(request: Request, ctx: Ctx) {
  const parsed = entrada.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ erro: "Texto da anotação é obrigatório" }, { status: 400 });

  try {
    const { id } = await ctx.params;
    const criada = await api().criarAnotacao(id, parsed.data.texto);
    const notaId = (criada as Record<string, unknown> | null)?.id;
    await db().from("crm_card_notes").insert({
      id: typeof notaId === "string" && notaId ? notaId : crypto.randomUUID(),
      card_id: id,
      session_id: parsed.data.sessionId ?? null,
      text: parsed.data.texto,
      raw: criada ?? {},
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return erroJson(e);
  }
}
