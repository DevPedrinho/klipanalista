export function Aviso({ titulo, children, tom = "erro" }: { titulo: string; children?: React.ReactNode; tom?: "erro" | "info" }) {
  const cores = tom === "erro" ? "border-red-200 bg-red-50 text-red-800" : "border-marca-100 bg-marca-50 text-marca-700";
  return (
    <div className={`rounded-lg border p-4 text-sm ${cores}`}>
      <p className="font-medium">{titulo}</p>
      {children ? <div className="mt-1 whitespace-pre-wrap">{children}</div> : null}
    </div>
  );
}

export function BotaoAbrirAtendimento({ url, compacto = false }: { url: string | null; compacto?: boolean }) {
  if (!url) return <span className="text-xs text-slate-400">sem link</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={
        compacto
          ? "whitespace-nowrap rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          : "whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      Abrir atendimento ↗
    </a>
  );
}
