import { describe, expect, it, vi } from "vitest";
import { criarCliente, KlipflowiError } from "@/lib/klipflowi/client";

function resposta(status: number, corpo: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(corpo), { status, headers });
}

describe("cliente KlipFlowi", () => {
  it("pagina com pageNumber/pageSize e envia o Bearer", async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { items: [], totalPages: 3, totalItems: 120 }));
    const c = criarCliente({ baseUrl: "https://api.wts.chat", token: "pn_x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = await c.pagina("/chat/v2/session", 3);
    expect(p.totalPages).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("pageNumber")).toBe("3");
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pn_x");
  });

  it("repete 429 respeitando Retry-After e depois devolve", async () => {
    const dormir = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(resposta(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(resposta(200, { ok: true }));
    const c = criarCliente({ baseUrl: "https://x.test", token: "t", fetchImpl, dormir });
    await expect(c.request("/a")).resolves.toEqual({ ok: true });
    expect(dormir).toHaveBeenCalledWith(2000);
  });

  it("não repete 400 e expõe o corpo do erro", async () => {
    const fetchImpl = vi.fn(async () => resposta(400, { message: "The PanelId field is required." }));
    const c = criarCliente({ baseUrl: "https://x.test", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    const erro = (await c.request("/a").catch((e) => e)) as KlipflowiError;
    expect(erro).toBeInstanceOf(KlipflowiError);
    expect(erro.status).toBe(400);
    expect(erro.message).toContain("PanelId");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("todasAsPaginas para quando a página vem incompleta ou repetida", async () => {
    const cheia = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}` }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(resposta(200, { items: cheia }))
      .mockResolvedValueOnce(resposta(200, { items: cheia })); // API ignorou a página: repetida
    const c = criarCliente({ baseUrl: "https://x.test", token: "t", fetchImpl });
    const itens = await c.todasAsPaginas("/m");
    expect(itens).toHaveLength(50);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
