import "server-only";
import type { Db } from "../servidor";
import type { RepoSync } from "./sincronizar";

function checar<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(`Supabase: ${r.error.message}`);
  return r.data;
}

function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

export function repoSupabase(db: Db): RepoSync {
  return {
    async salvarAtendentes(rows) {
      if (rows.length === 0) return;
      const agora = new Date().toISOString();
      checar(await db.from("agents").upsert(rows.map((r) => ({ ...r, synced_at: agora }))));
    },

    async estadoDasConversas(ids) {
      const data = checar(
        await db.from("sessions").select("id, last_interaction_at, needs_message_sync").in("id", ids),
      );
      return new Map((data ?? []).map((r) => [r.id as string, r as { last_interaction_at: string | null; needs_message_sync: boolean }]));
    },

    async salvarConversas(rows) {
      const agora = new Date().toISOString();
      checar(await db.from("sessions").upsert(rows.map((r) => ({ ...r, synced_at: agora }))));
    },

    async conversasPendentes(limite, tentadasAntesDe) {
      const data = checar(
        await db
          .from("sessions")
          .select("id")
          .eq("needs_message_sync", true)
          .or(`messages_synced_at.is.null,messages_synced_at.lt.${tentadasAntesDe}`)
          .order("last_interaction_at", { ascending: false })
          .limit(limite),
      );
      return (data ?? []).map((r) => r.id as string);
    },

    async salvarMensagens(sessionId, rows, resumo) {
      for (const lote of emLotes(rows, 500)) {
        checar(await db.from("messages").upsert(lote));
      }
      checar(
        await db
          .from("sessions")
          .update({
            message_count: resumo.message_count,
            audio_count: resumo.audio_count,
            pending_transcriptions: resumo.pending_transcriptions,
            // Transcrição ainda processando: a próxima sincronização busca de novo.
            needs_message_sync: resumo.transcricao_em_andamento,
            messages_synced_at: new Date().toISOString(),
            message_sync_error: null,
          })
          .eq("id", sessionId),
      );
    },

    async marcarErroMensagens(sessionId, erro) {
      checar(
        await db
          .from("sessions")
          .update({ message_sync_error: erro.slice(0, 500), messages_synced_at: new Date().toISOString() })
          .eq("id", sessionId),
      );
    },

    async contatosFaltando(limite, ignorar) {
      let q = db.from("v_contatos_faltando").select("id").limit(limite + ignorar.length);
      if (ignorar.length > 0) q = q.not("id", "in", `(${ignorar.map((i) => `"${i}"`).join(",")})`);
      const data = checar(await q);
      return (data ?? []).map((r) => r.id as string).slice(0, limite);
    },

    async salvarContatos(rows) {
      if (rows.length === 0) return;
      const agora = new Date().toISOString();
      checar(await db.from("contacts").upsert(rows.map((r) => ({ ...r, synced_at: agora }))));
    },
  };
}
