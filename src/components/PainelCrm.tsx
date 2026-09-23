"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Card = { id: string; title: string | null };
type Painel = { id: string; title: string | null; type: string | null };
type Etapa = { id: string; title: string | null; final: boolean };
type Anotacao = { id: string; texto: string; criadaEm: string | null; autor: string | null };

async function chamar<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detalhe = corpo.detalhe ? `\n${JSON.stringify(corpo.detalhe, null, 2)}` : "";
    throw new Error(`${corpo.erro ?? `Erro ${r.status}`}${detalhe}`);
  }
  return corpo as T;
}

export function PainelCrm(props: {
  sessionId: string;
  temContato: boolean;
  tituloSugerido: string;
  responsavelSugerido: string | null;
  resumo: string;
  cards: Card[];
}) {
  const [criando, setCriando] = useState(false);
  const [cardAtivo, setCardAtivo] = useState<string | null>(props.cards.at(-1)?.id ?? null);

  return (
    <aside className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">CRM</h2>
        {props.cards.length > 0 ? (
          <ul className="mb-3 space-y-1 text-sm">
            {props.cards.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setCardAtivo(c.id)}
                  className={`w-full rounded px-2 py-1 text-left ${cardAtivo === c.id ? "bg-marca-50 text-marca-700" : "hover:bg-slate-50"}`}
                >
                  🗂️ {c.title ?? c.id}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm text-slate-500">Nenhum card criado por aqui para este atendimento.</p>
        )}
        {props.temContato ? (
          <button
            onClick={() => setCriando(true)}
            className="w-full rounded-md bg-marca-600 px-3 py-2 text-sm font-medium text-white hover:bg-marca-700"
          >
            {props.cards.length > 0 ? "Criar outro card" : "Criar card no CRM"}
          </button>
        ) : (
          <p className="text-xs text-amber-700">Atendimento sem contato vinculado: não dá para criar card.</p>
        )}
      </div>

      {cardAtivo ? <Anotacoes key={cardAtivo} cardId={cardAtivo} sessionId={props.sessionId} resumo={props.resumo} /> : null}

      {criando ? (
        <ModalNovoCard
          {...props}
          fechar={() => setCriando(false)}
          criado={(id) => {
            setCriando(false);
            setCardAtivo(id);
          }}
        />
      ) : null}
    </aside>
  );
}

function ModalNovoCard(props: {
  sessionId: string;
  tituloSugerido: string;
  responsavelSugerido: string | null;
  fechar: () => void;
  criado: (id: string) => void;
}) {
  const router = useRouter();
  const [paineis, setPaineis] = useState<Painel[] | null>(null);
  const [etapas, setEtapas] = useState<Etapa[] | null>(null);
  const [panelId, setPanelId] = useState("");
  const [stepId, setStepId] = useState("");
  const [titulo, setTitulo] = useState(props.tituloSugerido);
  const [valor, setValor] = useState("");
  const [usarResponsavel, setUsarResponsavel] = useState(Boolean(props.responsavelSugerido));
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    chamar<{ paineis: Painel[] }>("/api/crm/paineis")
      .then((r) => setPaineis(r.paineis))
      .catch((e: Error) => setErro(e.message));
  }, []);

  async function escolherPainel(id: string) {
    setPanelId(id);
    setStepId("");
    setEtapas(null);
    if (!id) return;
    try {
      const r = await chamar<{ etapas: Etapa[] }>(`/api/crm/paineis/${id}/etapas`);
      setEtapas(r.etapas);
      setStepId(r.etapas.find((e) => !e.final)?.id ?? "");
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  const valorNumero = valor ? Number(valor.replace(/\./g, "").replace(",", ".")) : undefined;
  const corpo = {
    sessionId: props.sessionId,
    panelId,
    stepId,
    title: titulo.trim(),
    ...(usarResponsavel && props.responsavelSugerido ? { responsibleUserId: props.responsavelSugerido } : {}),
    ...(valorNumero !== undefined && Number.isFinite(valorNumero) ? { monetaryAmount: valorNumero } : {}),
  };
  const valido = Boolean(panelId && stepId && corpo.title) && (valor === "" || Number.isFinite(valorNumero));

  async function criar() {
    setEnviando(true);
    setErro(null);
    try {
      const r = await chamar<{ card: { id: string } }>("/api/crm/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      router.refresh();
      props.criado(r.card.id);
    } catch (e) {
      setErro((e as Error).message);
      setConfirmando(false);
    } finally {
      setEnviando(false);
    }
  }

  const nomeEtapa = etapas?.find((e) => e.id === stepId)?.title ?? stepId;
  const nomePainel = paineis?.find((p) => p.id === panelId)?.title ?? panelId;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg space-y-3 rounded-lg bg-white p-5 text-sm shadow-xl">
        <h3 className="text-base font-semibold">Criar card no CRM</h3>

        {!confirmando ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Painel</span>
              <select value={panelId} onChange={(e) => escolherPainel(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5">
                <option value="">{paineis ? "Selecione…" : "Carregando…"}</option>
                {(paineis ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title ?? p.id} {p.type === "SALES" ? "· vendas" : ""}
                  </option>
                ))}
              </select>
            </label>

            {panelId ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">Etapa</span>
                <select value={stepId} onChange={(e) => setStepId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5">
                  <option value="">{etapas ? "Selecione…" : "Carregando…"}</option>
                  {(etapas ?? []).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title ?? e.id} {e.final ? "(etapa final)" : ""}
                    </option>
                  ))}
                </select>
                {etapas && etapas.length === 0 ? (
                  <span className="text-xs text-amber-700">
                    Este painel ainda não tem cards, e a API não informa as etapas de painel vazio. Escolha outro painel.
                  </span>
                ) : null}
              </label>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Título</span>
              <input value={titulo} onChange={(e) => setTitulo(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Valor (opcional, R$)</span>
              <input value={valor} onChange={(e) => setValor(e.target.value)} placeholder="ex.: 5.000,00" className="rounded-md border border-slate-300 px-2 py-1.5" />
            </label>

            {props.responsavelSugerido ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={usarResponsavel} onChange={(e) => setUsarResponsavel(e.target.checked)} />
                Responsável: o atendente desta conversa
              </label>
            ) : null}
          </>
        ) : (
          <div className="space-y-2">
            <p>Confira antes de gravar na KlipFlowi:</p>
            <ul className="rounded-md bg-slate-50 p-3">
              <li><b>Painel:</b> {nomePainel}</li>
              <li><b>Etapa:</b> {nomeEtapa}</li>
              <li><b>Título:</b> {corpo.title}</li>
              {"monetaryAmount" in corpo ? <li><b>Valor:</b> R$ {valor}</li> : null}
              {"responsibleUserId" in corpo ? <li><b>Responsável:</b> atendente da conversa</li> : null}
              <li><b>Contato:</b> o contato deste atendimento</li>
            </ul>
          </div>
        )}

        {erro ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">{erro}</pre> : null}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={confirmando ? () => setConfirmando(false) : props.fechar} className="rounded-md border border-slate-300 px-3 py-1.5">
            {confirmando ? "Voltar" : "Cancelar"}
          </button>
          {confirmando ? (
            <button onClick={criar} disabled={enviando} className="rounded-md bg-marca-600 px-3 py-1.5 font-medium text-white disabled:opacity-60">
              {enviando ? "Criando…" : "Confirmar e criar"}
            </button>
          ) : (
            <button onClick={() => setConfirmando(true)} disabled={!valido} className="rounded-md bg-marca-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">
              Revisar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Anotacoes({ cardId, sessionId, resumo }: { cardId: string; sessionId: string; resumo: string }) {
  const [lista, setLista] = useState<Anotacao[] | null>(null);
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [versao, setVersao] = useState(0);

  useEffect(() => {
    let ativo = true;
    chamar<{ anotacoes: Anotacao[] }>(`/api/crm/card/${cardId}/note`)
      .then((r) => ativo && setLista(r.anotacoes))
      .catch((e: Error) => {
        if (!ativo) return;
        setErro(e.message);
        setLista([]);
      });
    return () => {
      ativo = false;
    };
  }, [cardId, versao]);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      await chamar(`/api/crm/card/${cardId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto, sessionId }),
      });
      setTexto("");
      setVersao((v) => v + 1);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 className="font-semibold">Anotações do card</h2>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        rows={5}
        placeholder="Escreva uma anotação…"
        className="w-full rounded-md border border-slate-300 p-2"
      />
      <div className="flex justify-between gap-2">
        <button onClick={() => setTexto((t) => (t ? `${t}\n\n${resumo}` : resumo))} className="text-xs text-marca-600 hover:underline">
          Inserir resumo da conversa
        </button>
        <button
          onClick={salvar}
          disabled={salvando || !texto.trim()}
          className="rounded-md bg-marca-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {salvando ? "Salvando…" : "Salvar anotação"}
        </button>
      </div>
      {erro ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">{erro}</pre> : null}
      <ul className="space-y-2 pt-2">
        {lista === null ? <li className="text-slate-400">Carregando…</li> : null}
        {lista?.length === 0 ? <li className="text-slate-400">Nenhuma anotação ainda.</li> : null}
        {lista?.map((a) => (
          <li key={a.id} className="rounded bg-slate-50 p-2">
            <p className="whitespace-pre-wrap">{a.texto}</p>
            <p className="mt-1 text-[10px] text-slate-400">
              {a.autor ?? ""} {a.criadaEm ? new Date(a.criadaEm).toLocaleString("pt-BR") : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
