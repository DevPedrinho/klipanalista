import { Aviso } from "@/components/Aviso";
import { Limpeza } from "@/components/Limpeza";
import { bytes, dataHora } from "@/lib/formato";
import { env } from "@/lib/env";
import { db } from "@/lib/servidor";

export const dynamic = "force-dynamic";

const NOMES: Record<string, string> = {
  sessions: "Conversas",
  messages: "Mensagens",
  contacts: "Contatos",
  agents: "Atendentes",
  sync_runs: "Sincronizações",
  crm_panels: "Painéis (cache)",
  crm_cards: "Cards criados",
  crm_card_notes: "Anotações criadas",
};

export default async function Configuracoes() {
  let banco;
  let janela = 7;
  let retencao: number | undefined;
  try {
    banco = db();
    janela = env().SYNC_JANELA_DIAS;
    retencao = env().RETENCAO_DIAS;
  } catch (e) {
    return <Aviso titulo="Configuração incompleta">{e instanceof Error ? e.message : String(e)}</Aviso>;
  }

  const [uso, runs] = await Promise.all([
    banco.rpc("uso_do_banco"),
    banco.from("sync_runs").select("id, started_at, finished_at, status, phase, stats, error, origem").order("started_at", { ascending: false }).limit(10),
  ]);

  const tabelas = (uso.data ?? []) as { tabela: string; linhas: number; bytes: number }[];
  const total = tabelas.reduce((s, t) => s + Number(t.bytes), 0);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Configurações</h1>

      <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Sincronização</h2>
        <p className="text-slate-600">
          Janela: conversas com interação nos últimos <b>{janela} dias</b> (variável <code>SYNC_JANELA_DIAS</code>). Roda
          automaticamente 1x por dia e pelo botão “Sincronizar agora”.
        </p>
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1">Início</th>
              <th>Origem</th>
              <th>Status</th>
              <th>Conversas</th>
              <th>Mensagens</th>
              <th>Áudios</th>
              <th>Erros</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => {
              const st = (r.stats ?? {}) as Record<string, number>;
              return (
                <tr key={r.id as number} className="border-t border-slate-100" title={(r.error as string) ?? undefined}>
                  <td className="py-1">{dataHora(r.started_at as string)}</td>
                  <td>{r.origem as string}</td>
                  <td>
                    {r.status as string}
                    {r.status === "rodando" ? ` (${r.phase})` : ""}
                  </td>
                  <td>{st.conversas ?? 0}</td>
                  <td>{st.mensagens ?? 0}</td>
                  <td>
                    {st.audios ?? 0}
                    {st.audiosSemTranscricao ? ` (${st.audiosSemTranscricao} sem transcrição)` : ""}
                  </td>
                  <td className={st.erros ? "text-red-600" : ""}>{st.erros ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Limpeza do banco</h2>
        {uso.error ? (
          <Aviso titulo="Não foi possível medir o banco">{uso.error.message}</Aviso>
        ) : (
          <>
            <p className="text-slate-600">
              Espaço ocupado pelo Klip Analista: <b>{bytes(total)}</b>
            </p>
            <ul className="grid grid-cols-2 gap-1 text-xs text-slate-600 sm:grid-cols-4">
              {tabelas.map((t) => (
                <li key={t.tabela}>
                  {NOMES[t.tabela] ?? t.tabela}: {Math.max(0, Number(t.linhas)).toLocaleString("pt-BR")} · {bytes(Number(t.bytes))}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-xs text-slate-500">
          Retenção automática: {retencao ? `conversas sem interação há mais de ${retencao} dias são apagadas no cron diário` : "desligada"} (
          <code>RETENCAO_DIAS</code>). A limpeza apaga só os dados deste app; nada é apagado na KlipFlowi.
        </p>
        <Limpeza />
      </section>
    </div>
  );
}
