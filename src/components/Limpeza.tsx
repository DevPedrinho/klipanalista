"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function Limpeza() {
  const router = useRouter();
  const [dias, setDias] = useState("30");
  const [confirmacao, setConfirmacao] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [mensagem, setMensagem] = useState<string | null>(null);

  async function limpar(modo: "antigas" | "tudo") {
    setOcupado(true);
    setMensagem(null);
    try {
      const r = await fetch("/api/limpeza", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modo === "antigas" ? { modo, dias: Number(dias), confirmacao } : { modo, confirmacao }),
      });
      const corpo = await r.json();
      if (!r.ok) throw new Error(corpo.erro ?? `Erro ${r.status}`);
      setMensagem(modo === "antigas" ? `${corpo.apagadas} conversas apagadas.` : "Todos os dados do Klip Analista foram apagados.");
      setConfirmacao("");
      router.refresh();
    } catch (e) {
      setMensagem((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  const liberado = confirmacao === "APAGAR" && !ocupado;

  return (
    <div className="space-y-3 rounded-md border border-red-200 bg-red-50/50 p-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-600">Para liberar os botões, digite APAGAR</span>
        <input value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} className="w-40 rounded-md border border-slate-300 px-2 py-1" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span>Apagar conversas sem interação há mais de</span>
        <input value={dias} onChange={(e) => setDias(e.target.value)} type="number" min={1} className="w-20 rounded-md border border-slate-300 px-2 py-1" />
        <span>dias</span>
        <button onClick={() => limpar("antigas")} disabled={!liberado || !(Number(dias) > 0)} className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-red-700 disabled:opacity-50">
          Apagar antigas
        </button>
      </div>
      <button onClick={() => limpar("tudo")} disabled={!liberado} className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">
        Apagar tudo do Klip Analista
      </button>
      {mensagem ? <p className="text-xs text-slate-700">{mensagem}</p> : null}
    </div>
  );
}
