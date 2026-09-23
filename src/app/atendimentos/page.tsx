import Link from "next/link";
import { Aviso, BotaoAbrirAtendimento } from "@/components/Aviso";
import { BotaoSincronizar } from "@/components/BotaoSincronizar";
import { dataHora, diasAtras, relativo } from "@/lib/formato";
import { db } from "@/lib/servidor";

export const dynamic = "force-dynamic";

const POR_PAGINA = 50;

type Filtros = {
  q?: string;
  agente?: string;
  status?: string;
  dias?: string;
  audio?: string;
  pendente?: string;
  pagina?: string;
};

type Linha = {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  agent_name: string | null;
  status: string | null;
  last_interaction_at: string | null;
  preview_url: string | null;
  message_count: number;
  audio_count: number;
  pending_transcriptions: number;
  needs_message_sync: boolean;
  messages_synced_at: string | null;
  message_sync_error: string | null;
};

export default async function Atendimentos({ searchParams }: { searchParams: Promise<Filtros> }) {
  const f = await searchParams;
  const pagina = Math.max(1, Number(f.pagina) || 1);

  let banco;
  try {
    banco = db();
  } catch (e) {
    return <Aviso titulo="Configuração incompleta">{e instanceof Error ? e.message : String(e)}</Aviso>;
  }

  let consulta = banco
    .from("v_atendimentos")
    .select("*", { count: "exact" })
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .range((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA - 1);

  const busca = (f.q ?? "").replace(/[,()*%]/g, " ").trim();
  if (busca) consulta = consulta.or(`contact_name.ilike.*${busca}*,contact_phone.ilike.*${busca}*`);
  if (f.agente) consulta = consulta.eq("agent_id", f.agente);
  if (f.status) consulta = consulta.eq("status", f.status);
  if (f.dias) consulta = consulta.gte("last_interaction_at", diasAtras(Number(f.dias)));
  if (f.audio) consulta = consulta.gt("audio_count", 0);
  if (f.pendente) consulta = consulta.gt("pending_transcriptions", 0);

  const [lista, agentes, ultimaSync, statusRecentes] = await Promise.all([
    consulta,
    banco.from("agents").select("id, name").order("name"),
    banco.from("sync_runs").select("started_at, finished_at, status, error").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    // A API não documenta os valores de status: listamos os que existem no banco.
    banco.from("sessions").select("status").order("last_interaction_at", { ascending: false }).limit(1000),
  ]);
  const statusDisponiveis = [...new Set((statusRecentes.data ?? []).map((r) => r.status as string | null).filter(Boolean))] as string[];

  if (lista.error) {
    return <Aviso titulo="Não foi possível ler o banco">{lista.error.message}</Aviso>;
  }

  const linhas = (lista.data ?? []) as Linha[];
  const total = lista.count ?? 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const sync = ultimaSync.data;

  const link = (mudanca: Partial<Filtros>) => {
    const p = new URLSearchParams(Object.entries({ ...f, ...mudanca }).filter(([, v]) => v) as [string, string][]);
    return `/atendimentos?${p}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Atendimentos</h1>
          <p className="text-sm text-slate-500">
            {total} conversas · última sincronização{" "}
            {sync ? `${relativo(sync.finished_at ?? sync.started_at)} (${sync.status})` : "nunca"}
          </p>
          {sync?.error ? <p className="text-xs text-red-600">Erro na última sincronização: {sync.error}</p> : null}
        </div>
        <BotaoSincronizar />
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Contato ou telefone</span>
          <input name="q" defaultValue={f.q} className="rounded-md border border-slate-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Atendente</span>
          <select name="agente" defaultValue={f.agente ?? ""} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="">Todos</option>
            {(agentes.data ?? []).map((a) => (
              <option key={a.id as string} value={a.id as string}>
                {(a.name as string) ?? a.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Status</span>
          <select name="status" defaultValue={f.status ?? ""} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="">Todos</option>
            {statusDisponiveis.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Período</span>
          <select name="dias" defaultValue={f.dias ?? ""} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="">Tudo sincronizado</option>
            <option value="1">Último dia</option>
            <option value="3">Últimos 3 dias</option>
            <option value="7">Últimos 7 dias</option>
            <option value="30">Últimos 30 dias</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="audio" value="1" defaultChecked={Boolean(f.audio)} /> Tem áudio
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="pendente" value="1" defaultChecked={Boolean(f.pendente)} /> Transcrição pendente
        </label>
        <button className="rounded-md bg-slate-800 px-3 py-1.5 text-white">Filtrar</button>
        <Link href="/atendimentos" className="text-slate-500 hover:underline">
          Limpar
        </Link>
      </form>

      {linhas.length === 0 ? (
        <Aviso titulo="Nenhum atendimento encontrado" tom="info">
          {total === 0 && !busca ? "Clique em “Sincronizar agora” para puxar as conversas da KlipFlowi." : "Ajuste os filtros."}
        </Aviso>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Contato</th>
                <th className="px-3 py-2">Atendente</th>
                <th className="px-3 py-2">Última interação</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Mensagens</th>
                <th className="px-3 py-2 text-right">Áudios</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {linhas.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link href={`/atendimentos/${l.id}`} className="font-medium text-marca-600 hover:underline">
                      {l.contact_name ?? "Contato sem nome"}
                    </Link>
                    <div className="text-xs text-slate-500">{l.contact_phone ?? ""}</div>
                  </td>
                  <td className="px-3 py-2">{l.agent_name ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{dataHora(l.last_interaction_at)}</td>
                  <td className="px-3 py-2 text-xs">{l.status ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {l.messages_synced_at ? l.message_count : <span className="text-xs text-slate-400">aguardando</span>}
                    {l.message_sync_error ? <span title={l.message_sync_error} className="ml-1 text-red-600">⚠</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {l.audio_count > 0 ? `🎙️ ${l.audio_count}` : "—"}
                    {l.pending_transcriptions > 0 ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                        {l.pending_transcriptions} sem transcrição
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <BotaoAbrirAtendimento url={l.preview_url} compacto />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paginas > 1 ? (
        <div className="flex items-center justify-between text-sm">
          {pagina > 1 ? <Link href={link({ pagina: String(pagina - 1) })} className="text-marca-600">← Anterior</Link> : <span />}
          <span className="text-slate-500">
            Página {pagina} de {paginas}
          </span>
          {pagina < paginas ? <Link href={link({ pagina: String(pagina + 1) })} className="text-marca-600">Próxima →</Link> : <span />}
        </div>
      ) : null}
    </div>
  );
}
