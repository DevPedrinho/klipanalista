const FUSO = "America/Sao_Paulo";

export function dataHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: FUSO }).format(new Date(iso));
}

export function hora(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("pt-BR", { timeStyle: "short", timeZone: FUSO }).format(new Date(iso));
}

export function dia(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: FUSO }).format(new Date(iso));
}

export function relativo(iso: string | null | undefined, agora = Date.now()): string {
  if (!iso) return "nunca";
  const min = Math.round((agora - Date.parse(iso)) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Instante de N dias atrás, em ISO. */
export function diasAtras(dias: number): string {
  return new Date(Date.now() - dias * 86_400_000).toISOString();
}
