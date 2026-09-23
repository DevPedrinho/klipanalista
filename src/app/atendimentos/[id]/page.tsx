import Link from "next/link";
import { notFound } from "next/navigation";
import { Aviso, BotaoAbrirAtendimento } from "@/components/Aviso";
import { PainelCrm } from "@/components/PainelCrm";
import { dataHora, dia, hora } from "@/lib/formato";
import { db } from "@/lib/servidor";

export const dynamic = "force-dynamic";

type Mensagem = {
  id: string;
  sent_at: string | null;
  direction: "cliente" | "atendente";
  type: string | null;
  text: string | null;
  transcription: string | null;
  transcription_status: "ok" | "processando" | "erro" | "ausente" | null;
  media_url: string | null;
};

export default async function Atendimento({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let banco;
  try {
    banco = db();
  } catch (e) {
    return <Aviso titulo="Configuração incompleta">{e instanceof Error ? e.message : String(e)}</Aviso>;
  }

  const [sessao, mensagens, cards] = await Promise.all([
    banco.from("v_atendimentos").select("*").eq("id", id).maybeSingle(),
    banco.from("messages").select("id, sent_at, direction, type, text, transcription, transcription_status, media_url").eq("session_id", id).order("sent_at"),
    banco.from("crm_cards").select("id, title, panel_id, created_at").eq("session_id", id).order("created_at"),
  ]);

  if (sessao.error) return <Aviso titulo="Erro ao ler o atendimento">{sessao.error.message}</Aviso>;
  if (!sessao.data) notFound();
  const s = sessao.data;
  const msgs = (mensagens.data ?? []) as Mensagem[];

  const resumo = [
    `Contato: ${s.contact_name ?? "sem nome"}${s.contact_phone ? ` (${s.contact_phone})` : ""}`,
    `Atendente: ${s.agent_name ?? "—"}`,
    `Período: ${dataHora(msgs[0]?.sent_at ?? s.created_at)} a ${dataHora(s.last_interaction_at)}`,
    `Mensagens: ${s.message_count} (${s.audio_count} áudios)`,
    s.preview_url ? `Atendimento: ${s.preview_url}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let diaAnterior = "";

  return (
    <div className="space-y-4">
      <Link href="/atendimentos" className="text-sm text-slate-500 hover:underline">
        ← Atendimentos
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <h1 className="text-xl font-semibold">{s.contact_name ?? "Contato sem nome"}</h1>
          <p className="text-sm text-slate-500">
            {s.contact_phone ?? ""} · atendente {s.agent_name ?? "—"} · {s.status ?? ""}
          </p>
          <p className="text-sm text-slate-500">
            {s.message_count} mensagens · {s.audio_count} áudios · última interação {dataHora(s.last_interaction_at)}
          </p>
        </div>
        <BotaoAbrirAtendimento url={s.preview_url} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
          {s.message_sync_error ? <Aviso titulo="Falha ao baixar as mensagens">{s.message_sync_error}</Aviso> : null}
          {msgs.length === 0 ? (
            <p className="text-sm text-slate-500">
              {s.messages_synced_at ? "Nenhuma mensagem nesta conversa." : "Mensagens ainda não sincronizadas."}
            </p>
          ) : (
            msgs.map((m) => {
              const d = dia(m.sent_at);
              const separador = d !== diaAnterior ? d : null;
              diaAnterior = d;
              const cliente = m.direction === "cliente";
              return (
                <div key={m.id}>
                  {separador ? <p className="my-3 text-center text-xs text-slate-400">{separador}</p> : null}
                  <div className={`flex ${cliente ? "justify-start" : "justify-end"}`}>
                    <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${cliente ? "bg-slate-100" : "bg-marca-50"}`}>
                      <Conteudo m={m} />
                      <p className="mt-1 text-right text-[10px] text-slate-400">
                        {cliente ? "cliente" : "atendente"} · {hora(m.sent_at)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </section>

        <PainelCrm
          sessionId={s.id}
          temContato={Boolean(s.contact_id)}
          tituloSugerido={`${s.contact_name ?? "Contato"} — ${dataHora(s.last_interaction_at).split(" ")[0]}`}
          responsavelSugerido={s.agent_id}
          resumo={resumo}
          cards={(cards.data ?? []) as { id: string; title: string | null }[]}
        />
      </div>
    </div>
  );
}

function Conteudo({ m }: { m: Mensagem }) {
  if (m.transcription_status) {
    return (
      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">🎙️ Áudio</p>
        {m.transcription_status === "ok" ? (
          <p className="whitespace-pre-wrap italic">{m.transcription}</p>
        ) : (
          <p className="text-xs text-amber-700">
            {m.transcription_status === "processando"
              ? "Transcrição em processamento na KlipFlowi — será buscada na próxima sincronização."
              : m.transcription_status === "erro"
                ? "A KlipFlowi não conseguiu transcrever este áudio."
                : "Áudio sem transcrição."}
          </p>
        )}
        {m.media_url ? (
          <audio controls preload="none" src={m.media_url} className="mt-2 h-8 w-full" />
        ) : null}
      </div>
    );
  }
  if (m.text) return <p className="whitespace-pre-wrap">{m.text}</p>;
  return (
    <p className="text-xs text-slate-500">
      [{m.type ?? "mensagem sem texto"}]
      {m.media_url ? (
        <a href={m.media_url} target="_blank" rel="noopener noreferrer" className="ml-1 text-marca-600 underline">
          abrir arquivo
        </a>
      ) : null}
    </p>
  );
}
