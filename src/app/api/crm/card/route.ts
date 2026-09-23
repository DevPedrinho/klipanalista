import { NextResponse } from "next/server";
import { z } from "zod";
import { api, db } from "@/lib/servidor";
import { erroJson } from "@/lib/respostas";

export const dynamic = "force-dynamic";

const entrada = z.object({
  sessionId: z.string().min(1),
  panelId: z.string().min(1),
  stepId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  responsibleUserId: z.string().min(1).optional(),
  monetaryAmount: z.number().nonnegative().optional(),
});

/** Cria um card no CRM da KlipFlowi para o contato da conversa. */
export async function POST(request: Request) {
  const parsed = entrada.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ erro: "Dados inválidos", detalhe: z.flattenError(parsed.error) }, { status: 400 });
  }
  const { sessionId, ...campos } = parsed.data;

  try {
    const banco = db();
    const sessao = await banco.from("sessions").select("id, contact_id").eq("id", sessionId).maybeSingle();
    if (sessao.error) throw new Error(`Supabase: ${sessao.error.message}`);
    if (!sessao.data) return NextResponse.json({ erro: "Atendimento não encontrado" }, { status: 404 });
    if (!sessao.data.contact_id) {
      return NextResponse.json({ erro: "Este atendimento não tem contato vinculado" }, { status: 422 });
    }

    const corpo = { ...campos, contactIds: [sessao.data.contact_id as string] };
    const criado = await api().criarCard(corpo);
    const id = (criado as Record<string, unknown> | null)?.id;
    if (typeof id !== "string" || !id) {
      return NextResponse.json({ erro: "A KlipFlowi não devolveu o id do card", detalhe: criado }, { status: 502 });
    }

    const salvo = await banco.from("crm_cards").insert({
      id,
      session_id: sessionId,
      contact_id: sessao.data.contact_id,
      panel_id: campos.panelId,
      step_id: campos.stepId,
      title: campos.title,
      raw: criado,
    });
    if (salvo.error) throw new Error(`Card criado na KlipFlowi (${id}), mas não foi salvo aqui: ${salvo.error.message}`);

    return NextResponse.json({ card: { id, title: campos.title } }, { status: 201 });
  } catch (e) {
    return erroJson(e);
  }
}
