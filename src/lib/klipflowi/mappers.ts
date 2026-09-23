/**
 * Payload da API → linhas do banco. Funções puras, cobertas por tests/mappers.test.ts.
 */

type Bruto = Record<string, unknown>;

const obj = (v: unknown): Bruto | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : undefined;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
const data = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// Atendentes -------------------------------------------------------------------

export interface AgentRow {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  profile: string | null;
  departments: { id: string; name: string | null }[];
  raw: unknown;
}

export function mapAgent(raw: unknown): AgentRow | null {
  const r = obj(raw);
  const id = str(r?.id);
  if (!r || !id) return null;
  const departments = Array.isArray(r.departments)
    ? r.departments
        .map((d) => obj(d))
        .filter((d): d is Bruto => Boolean(d && str(d.id)))
        .map((d) => ({ id: str(d.id)!, name: str(d.name) }))
    : [];
  return {
    id,
    user_id: str(r.userId),
    name: str(r.name) ?? str(r.shortName),
    email: str(r.email),
    profile: r.isOwner === true ? "ADMIN" : str(r.profile),
    departments,
    raw,
  };
}

// Contatos ---------------------------------------------------------------------

export interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: unknown[];
  raw: unknown;
}

export function mapContact(raw: unknown): ContactRow | null {
  const r = obj(raw);
  const id = str(r?.id);
  if (!r || !id) return null;
  return {
    id,
    name: str(r.name),
    phone: str(r.phoneNumberFormatted) ?? str(r.phoneNumber),
    email: str(r.email),
    tags: Array.isArray(r.tags) ? r.tags : [],
    raw,
  };
}

// Conversas --------------------------------------------------------------------

export interface SessionRow {
  id: string;
  contact_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  status: string | null;
  channel: string | null;
  created_at: string | null;
  started_at: string | null;
  last_interaction_at: string | null;
  last_message_in_at: string | null;
  last_message_out_at: string | null;
  first_response_at: string | null;
  time_wait: number | null;
  time_service: number | null;
  preview_url: string | null;
  raw: unknown;
}

export function mapSession(raw: unknown): SessionRow | null {
  const r = obj(raw);
  const id = str(r?.id);
  if (!r || !id) return null;
  return {
    id,
    contact_id: str(r.contactId),
    agent_id: str(r.userId),
    agent_name: str(obj(r.agentDetails)?.name),
    status: str(r.status),
    channel: str(r.channelType),
    created_at: data(r.createdAt),
    started_at: data(r.startAt),
    // `lastInteractionDate` é a recência real; `updatedAt` muda por qualquer motivo.
    last_interaction_at: data(r.lastInteractionDate) ?? data(r.createdAt),
    last_message_in_at: data(r.lastMessageIn),
    last_message_out_at: data(r.lastMessageOut),
    first_response_at: data(r.firstResponseAt),
    time_wait: num(r.timeWait),
    time_service: num(r.timeService),
    preview_url: str(r.previewUrl),
    raw,
  };
}

/** A conversa está dentro da janela se foi criada ou teve interação depois do corte. */
export function dentroDaJanela(raw: unknown, corte: Date): boolean {
  const r = obj(raw);
  if (!r) return false;
  const limite = corte.getTime();
  return [r.lastInteractionDate, r.createdAt, r.lastMessageIn, r.lastMessageOut].some((v) => {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) && t >= limite;
  });
}

// Mensagens --------------------------------------------------------------------

export type StatusTranscricao = "ok" | "processando" | "erro" | "ausente";

export interface MessageRow {
  id: string;
  session_id: string;
  sent_at: string | null;
  direction: "cliente" | "atendente";
  author_user_id: string | null;
  type: string | null;
  text: string | null;
  transcription: string | null;
  transcription_status: StatusTranscricao | null;
  media_url: string | null;
  raw: unknown;
}

export function mapMessage(raw: unknown, sessionId: string): MessageRow | null {
  const r = obj(raw);
  const id = str(r?.id);
  if (!r || !id) return null;

  const details = obj(r.details);
  const file = obj(details?.file) ?? obj(r.file);
  const tipo = str(r.type) ?? str(r.messageType) ?? str(file?.mimeType);
  const transcricao = obj(details?.transcription);
  const ehAudio = Boolean(transcricao) || /audio|voice|ptt/i.test(tipo ?? "") || /^audio\//i.test(str(file?.mimeType) ?? "");

  let transcription: string | null = null;
  let transcription_status: StatusTranscricao | null = null;
  if (ehAudio) {
    if (transcricao?.error === true) transcription_status = "erro";
    else if (transcricao?.processing === true) transcription_status = "processando";
    else if (str(transcricao?.text)) {
      transcription = str(transcricao?.text);
      transcription_status = "ok";
    } else transcription_status = "ausente";
  }

  const autor = str(r.userId);
  return {
    id,
    session_id: sessionId,
    sent_at: data(r.createdAt) ?? data(r.timestamp),
    // `userId` preenchido = atendente escreveu; nulo = cliente. `direction` (FROM_HUB) não é confiável.
    direction: autor ? "atendente" : "cliente",
    author_user_id: autor,
    type: ehAudio ? "AUDIO" : tipo,
    text: str(r.text),
    transcription,
    transcription_status,
    media_url: str(file?.publicUrl) ?? str(file?.url) ?? str(r.fileUrl) ?? null,
    raw,
  };
}

export interface ResumoMensagens {
  message_count: number;
  audio_count: number;
  /** Áudios ainda sem transcrição utilizável (processando, erro ou ausente). */
  pending_transcriptions: number;
  /** Há transcrição em andamento: vale buscar de novo na próxima rodada. */
  transcricao_em_andamento: boolean;
}

export function resumirMensagens(mensagens: MessageRow[]): ResumoMensagens {
  const audios = mensagens.filter((m) => m.transcription_status !== null);
  return {
    message_count: mensagens.length,
    audio_count: audios.length,
    pending_transcriptions: audios.filter((m) => m.transcription_status !== "ok").length,
    transcricao_em_andamento: audios.some((m) => m.transcription_status === "processando"),
  };
}

// CRM --------------------------------------------------------------------------

export interface Etapa {
  id: string;
  title: string | null;
  final: boolean;
}

/** A API devolve `steps` nulo; as etapas vêm dos cards (stepId distintos). */
export function etapasDosCards(cards: unknown[]): Etapa[] {
  const porId = new Map<string, { title: string | null; abertos: number; fechados: number; fase: string | null; ordem: number }>();
  cards.forEach((c, i) => {
    const r = obj(c);
    const id = str(r?.stepId);
    if (!r || !id) return;
    const atual = porId.get(id) ?? { title: null, abertos: 0, fechados: 0, fase: null, ordem: i };
    atual.title ??= str(r.stepTitle);
    atual.fase ??= str(r.stepPhase);
    if (str(r.status) === "OPEN" || !str(r.status)) atual.abertos++;
    else atual.fechados++;
    porId.set(id, atual);
  });
  return [...porId.entries()]
    .sort((a, b) => a[1].ordem - b[1].ordem)
    .map(([id, e]) => ({
      id,
      title: e.title,
      final: e.fase ? e.fase === "FINAL" : e.abertos === 0 && e.fechados > 0,
    }));
}
