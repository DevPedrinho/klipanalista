import "server-only";
import { env } from "../env";
import { api, db } from "../servidor";
import { repoSupabase } from "./repo";
import { estadoInicial, executarRodada, type EstadoSync } from "./sincronizar";

/** Orçamento de trabalho por chamada: sobra folga até os 60s da Vercel Hobby. */
const ORCAMENTO_MS = 40_000;
/** Trava de uma rodada; se a função morrer, a trava expira sozinha. */
const TRAVA_MS = 70_000;

export interface ResultadoRodada {
  runId: number;
  status: "rodando" | "concluida" | "erro";
  fase: string;
  stats: EstadoSync["stats"];
  concluido: boolean;
  ocupado?: boolean;
  erro?: string;
}

type Run = {
  id: number;
  started_at: string;
  status: string;
  phase: string;
  cursor: EstadoSync["cursor"];
  stats: EstadoSync["stats"];
  error: string | null;
};

const paraResultado = (run: Run, extra: Partial<ResultadoRodada> = {}): ResultadoRodada => ({
  runId: run.id,
  status: run.status as ResultadoRodada["status"],
  fase: run.phase,
  stats: run.stats,
  concluido: run.status !== "rodando",
  ...(run.error ? { erro: run.error } : {}),
  ...extra,
});

/** Executa uma rodada: continua a sincronização em andamento ou começa uma nova. */
export async function rodarSincronizacao(origem: "manual" | "cron"): Promise<ResultadoRodada> {
  const banco = db();

  const { data: ultima, error } = await banco
    .from("sync_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase: ${error.message}`);

  let run = ultima as Run | null;
  if (!run || run.status !== "rodando") {
    const inicial = estadoInicial();
    const criada = await banco
      .from("sync_runs")
      .insert({ phase: inicial.fase, cursor: inicial.cursor, stats: inicial.stats, origem })
      .select("*")
      .single();
    if (criada.error) throw new Error(`Supabase: ${criada.error.message}`);
    run = criada.data as Run;
  }

  // Trava otimista: só uma rodada por vez.
  const agora = new Date();
  const travada = await banco
    .from("sync_runs")
    .update({ locked_until: new Date(agora.getTime() + TRAVA_MS).toISOString() })
    .eq("id", run.id)
    .lt("locked_until", agora.toISOString())
    .select("id");
  if (travada.error) throw new Error(`Supabase: ${travada.error.message}`);
  if ((travada.data ?? []).length === 0) return paraResultado(run, { ocupado: true });

  const corte = new Date(Date.now() - env().SYNC_JANELA_DIAS * 86_400_000);
  let estado: EstadoSync = { fase: run.phase as EstadoSync["fase"], cursor: run.cursor ?? {}, stats: run.stats };
  let erro: string | null = null;

  try {
    estado = await executarRodada(estado, api(), repoSupabase(banco), {
      corte,
      inicioDaSync: run.started_at,
      orcamentoMs: ORCAMENTO_MS,
    });
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }

  const status = erro ? "erro" : estado.fase === "fim" ? "concluida" : "rodando";
  const salvo = await banco
    .from("sync_runs")
    .update({
      phase: estado.fase,
      cursor: estado.cursor,
      stats: estado.stats,
      status,
      error: erro,
      finished_at: status === "rodando" ? null : new Date().toISOString(),
      locked_until: "-infinity",
    })
    .eq("id", run.id)
    .select("*")
    .single();
  if (salvo.error) throw new Error(`Supabase: ${salvo.error.message}`);
  return paraResultado(salvo.data as Run);
}

/** Retenção automática: apaga conversas (e mensagens, em cascata) mais antigas que N dias. */
export async function apagarConversasAntigas(dias: number): Promise<number> {
  const limite = new Date(Date.now() - dias * 86_400_000).toISOString();
  const { count, error } = await db()
    .from("sessions")
    .delete({ count: "exact" })
    .lt("last_interaction_at", limite);
  if (error) throw new Error(`Supabase: ${error.message}`);
  return count ?? 0;
}
