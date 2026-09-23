"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Resultado = {
  fase: string;
  concluido: boolean;
  ocupado?: boolean;
  erro?: string;
  stats: { conversas: number; conversasComMensagens: number; mensagens: number; audios: number; contatos: number; erros: number };
};

const NOME_DA_FASE: Record<string, string> = {
  atendentes: "atendentes",
  conversas: "lendo conversas",
  mensagens: "baixando mensagens e transcrições",
  contatos: "buscando contatos",
  fim: "concluído",
};

/** Chama /api/sync em rodadas até terminar, mostrando o progresso. */
export function BotaoSincronizar() {
  const router = useRouter();
  const [rodando, setRodando] = useState(false);
  const [progresso, setProgresso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function sincronizar() {
    setRodando(true);
    setErro(null);
    try {
      for (let rodada = 1; rodada <= 200; rodada++) {
        const resposta = await fetch("/api/sync", { method: "POST" });
        const corpo = (await resposta.json()) as Resultado & { erro?: string };
        if (resposta.status === 409) {
          setProgresso("Outra sincronização está em andamento; aguardando…");
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        if (!resposta.ok) throw new Error(corpo.erro ?? `Erro ${resposta.status}`);
        const s = corpo.stats;
        setProgresso(
          `${NOME_DA_FASE[corpo.fase] ?? corpo.fase} · ${s.conversas} conversas · ${s.conversasComMensagens} com mensagens · ${s.audios} áudios${s.erros ? ` · ${s.erros} erros` : ""}`,
        );
        router.refresh();
        if (corpo.erro) throw new Error(corpo.erro);
        if (corpo.concluido) break;
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setRodando(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={sincronizar}
        disabled={rodando}
        className="rounded-md bg-marca-600 px-4 py-2 text-sm font-medium text-white hover:bg-marca-700 disabled:opacity-60"
      >
        {rodando ? "Sincronizando…" : "Sincronizar agora"}
      </button>
      {progresso ? <p className="text-xs text-slate-500">{progresso}</p> : null}
      {erro ? <p className="max-w-md text-right text-xs text-red-600">{erro}</p> : null}
    </div>
  );
}
