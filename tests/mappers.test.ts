import { describe, expect, it } from "vitest";
import {
  dentroDaJanela,
  etapasDosCards,
  mapAgent,
  mapMessage,
  mapSession,
  resumirMensagens,
} from "@/lib/klipflowi/mappers";

// Nomes de campo lidos da conta real (valores sintéticos).
const SESSAO = {
  id: "sess_1",
  contactId: "contact_1",
  userId: "agent_1",
  agentDetails: { id: "agent_1", name: "Fulano" },
  channelType: "WHATSAPP",
  status: "OPEN",
  createdAt: "2026-03-01T09:00:00Z",
  startAt: "2026-03-01T09:01:00Z",
  lastInteractionDate: "2026-03-02T15:00:00Z",
  updatedAt: "2026-04-20T23:59:00Z",
  previewUrl: "https://app.exemplo.com/chat2/sessions/sess_1/preview",
  timeWait: 300,
  timeService: 3600,
};

describe("mapSession", () => {
  it("usa lastInteractionDate como recência, nunca updatedAt", () => {
    const s = mapSession(SESSAO)!;
    expect(s.last_interaction_at).toBe("2026-03-02T15:00:00.000Z");
    expect(s.agent_id).toBe("agent_1");
    expect(s.agent_name).toBe("Fulano");
    expect(s.preview_url).toContain("sess_1");
    expect(s.time_wait).toBe(300);
  });

  it("descarta conversa sem id", () => {
    expect(mapSession({ ...SESSAO, id: undefined })).toBeNull();
  });
});

describe("dentroDaJanela", () => {
  const corte = new Date("2026-03-02T00:00:00Z");
  it("aceita conversa criada antes mas com interação depois do corte", () => {
    expect(dentroDaJanela(SESSAO, corte)).toBe(true);
  });
  it("recusa conversa inteiramente anterior ao corte", () => {
    expect(dentroDaJanela({ ...SESSAO, lastInteractionDate: "2026-03-01T10:00:00Z" }, corte)).toBe(false);
  });
});

describe("mapMessage", () => {
  const base = { id: "m1", createdAt: "2026-03-01T09:00:00Z", direction: "FROM_HUB" };

  it("userId nulo = cliente; preenchido = atendente (FROM_HUB não decide)", () => {
    expect(mapMessage({ ...base, userId: null, text: "oi" }, "s")!.direction).toBe("cliente");
    expect(mapMessage({ ...base, userId: "agent_1", text: "olá" }, "s")!.direction).toBe("atendente");
  });

  it("lê a transcrição do áudio em details.transcription.text", () => {
    const m = mapMessage(
      { ...base, type: "AUDIO", text: null, details: { transcription: { text: "quero para dia 5", processing: false, error: false } } },
      "s",
    )!;
    expect(m.type).toBe("AUDIO");
    expect(m.transcription).toBe("quero para dia 5");
    expect(m.transcription_status).toBe("ok");
  });

  it("marca transcrição em processamento, com erro e ausente", () => {
    const proc = mapMessage({ ...base, type: "AUDIO", details: { transcription: { processing: true } } }, "s")!;
    const erro = mapMessage({ ...base, type: "AUDIO", details: { transcription: { error: true } } }, "s")!;
    const ausente = mapMessage({ ...base, type: "AUDIO" }, "s")!;
    expect(proc.transcription_status).toBe("processando");
    expect(erro.transcription_status).toBe("erro");
    expect(ausente.transcription_status).toBe("ausente");
  });

  it("mensagem de texto não tem status de transcrição", () => {
    expect(mapMessage({ ...base, type: "TEXT", text: "oi" }, "s")!.transcription_status).toBeNull();
  });
});

describe("resumirMensagens", () => {
  it("conta áudios pendentes e sinaliza transcrição em andamento", () => {
    const msgs = [
      mapMessage({ id: "1", text: "oi" }, "s")!,
      mapMessage({ id: "2", type: "AUDIO", details: { transcription: { text: "ok" } } }, "s")!,
      mapMessage({ id: "3", type: "AUDIO", details: { transcription: { processing: true } } }, "s")!,
    ];
    expect(resumirMensagens(msgs)).toEqual({
      message_count: 3,
      audio_count: 2,
      pending_transcriptions: 1,
      transcricao_em_andamento: true,
    });
  });
});

describe("mapAgent", () => {
  it("dono da conta vira ADMIN e departments é lista", () => {
    const a = mapAgent({ id: "a", name: "X", profile: "AGENT", isOwner: true, departments: [{ id: "d", name: "Vendas" }] })!;
    expect(a.profile).toBe("ADMIN");
    expect(a.departments).toEqual([{ id: "d", name: "Vendas" }]);
  });
});

describe("etapasDosCards", () => {
  it("deduz etapas distintas e marca como final a que só tem cards fechados", () => {
    const etapas = etapasDosCards([
      { id: "1", stepId: "prop", stepTitle: "Proposta", status: "OPEN" },
      { id: "2", stepId: "ganho", stepTitle: "Ganho", status: "WON" },
      { id: "3", stepId: "prop", status: "OPEN" },
    ]);
    expect(etapas).toEqual([
      { id: "prop", title: "Proposta", final: false },
      { id: "ganho", title: "Ganho", final: true },
    ]);
  });
});
