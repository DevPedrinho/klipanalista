import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contactsAdapter, tagsAdapter } from "@/server/integration/adapters";
import { ApiError } from "@/server/integration/http/client";
import { aplicarEtiquetas } from "@/server/services/tag-application.service";
import type { SuggestedAccountTag, Tag } from "@/domain/types";

/**
 * Aplicação de etiquetas — a primeira escrita real na API.
 *
 * Até aqui o módulo só lia. Esta é a primeira ação que altera a conta do
 * cliente, então o que ela NÃO faz importa tanto quanto o que faz:
 *
 *   - não cria etiqueta nenhuma: envia `tagIds`, nunca `tagNames`;
 *   - não substitui as etiquetas que a equipe marcou à mão;
 *   - não derruba a página quando a API recusa.
 *
 * Os adapters são substituídos por espiões: estes testes verificam a decisão,
 * não a rede.
 */

const ETIQUETAS_DA_CONTA: Tag[] = [
  { id: "t_gamer", accountId: "acc1", name: "PC Gamer" },
  { id: "t_faixa", accountId: "acc1", name: "4k-7k" },
];

function sugestao(over: Partial<SuggestedAccountTag> = {}): SuggestedAccountTag {
  return {
    tagId: "t_gamer",
    tagName: "PC Gamer",
    motivo: "O cliente mencionou isto na conversa.",
    origem: "MENCAO_NA_CONVERSA",
    ...over,
  };
}

interface Chamada {
  contactId: string;
  tagIds?: string[];
  tagNames?: string[];
  dryRun: boolean;
}

/**
 * Troca os dois adapters por espiões e devolve as chamadas registradas junto
 * com a forma de restaurá-los.
 */
function espionar(options: {
  etiquetas?: Tag[];
  resposta?: { applied: boolean; reason?: string; tagIds?: string[] };
  erro?: Error;
}) {
  const chamadas: Chamada[] = [];

  const listOriginal = tagsAdapter.list;
  const applyOriginal = contactsAdapter.applyTags;

  (tagsAdapter.list as unknown) = async () => ({
    data: options.etiquetas ?? ETIQUETAS_DA_CONTA,
    source: "live" as const,
    pendingValidation: [],
  });

  (contactsAdapter.applyTags as unknown) = async (params: Chamada) => {
    chamadas.push(params);
    if (options.erro) throw options.erro;
    return {
      data: options.resposta ?? { applied: true, tagIds: ["t_gamer", "t_faixa"] },
      source: "live" as const,
      pendingValidation: [],
    };
  };

  return {
    chamadas,
    restaurar() {
      tagsAdapter.list = listOriginal;
      contactsAdapter.applyTags = applyOriginal;
    },
  };
}

const BASE = {
  accountId: "acc1",
  contactId: "c_123",
  contactName: "Cristiano Silva",
};

describe("aplicar etiquetas — o que ela faz", () => {
  it("envia os ids das etiquetas sugeridas", async () => {
    const espiao = espionar({});

    try {
      const resultado = await aplicarEtiquetas({
        ...BASE,
        sugeridas: [
          sugestao(),
          sugestao({ tagId: "t_faixa", tagName: "4k-7k", origem: "FAIXA_DE_VALOR" }),
        ],
      });

      assert.equal(resultado.status, "EXECUTADA");
      assert.equal(espiao.chamadas.length, 1, "uma única chamada à API");
      assert.deepEqual([...(espiao.chamadas[0]?.tagIds ?? [])].sort(), ["t_faixa", "t_gamer"]);
    } finally {
      espiao.restaurar();
    }
  });

  it("nunca envia nome de etiqueta, que faria a plataforma criar", async () => {
    const espiao = espionar({});

    try {
      await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });

      assert.equal(
        espiao.chamadas[0]?.tagNames,
        undefined,
        "enviar `tagNames` criaria etiqueta sem aprovação",
      );
    } finally {
      espiao.restaurar();
    }
  });

  it("escreve de verdade: dryRun é falso", async () => {
    const espiao = espionar({});

    try {
      await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });
      assert.equal(espiao.chamadas[0]?.dryRun, false);
    } finally {
      espiao.restaurar();
    }
  });

  it("registra a lista que a API confirmou, não a que pedimos", async () => {
    const espiao = espionar({
      resposta: { applied: true, tagIds: ["t_gamer", "t_manual_da_equipe"] },
    });

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });

      assert.deepEqual(resultado.depois?.["etiquetasNoContatoDepois"], [
        "t_gamer",
        "t_manual_da_equipe",
      ]);
    } finally {
      espiao.restaurar();
    }
  });

  it("a auditoria guarda o motivo de cada etiqueta, nao so o nome", async () => {
    const espiao = espionar({});

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });

      assert.deepEqual(resultado.depois?.["etiquetasAplicadas"], [
        {
          nome: "PC Gamer",
          motivo: "O cliente mencionou isto na conversa.",
          origem: "MENCAO_NA_CONVERSA",
        },
      ]);
    } finally {
      espiao.restaurar();
    }
  });
});

describe("aplicar etiquetas — o que ela recusa fazer", () => {
  it("não chama a API quando não há sugestão nenhuma", async () => {
    const espiao = espionar({});

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, sugeridas: [] });

      assert.equal(espiao.chamadas.length, 0, "chamada inútil à API");
      assert.equal(resultado.status, "FALHOU");
    } finally {
      espiao.restaurar();
    }
  });

  /**
   * A lista de sugestões foi montada quando a página carregou. Se alguém
   * apagou a etiqueta nesse meio-tempo, enviar o id produziria um erro
   * obscuro da plataforma em vez de uma explicação.
   */
  it("não envia etiqueta que sumiu da conta desde a análise", async () => {
    const espiao = espionar({ etiquetas: [] });

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });

      assert.equal(espiao.chamadas.length, 0);
      assert.equal(resultado.status, "FALHOU");
      assert.match(resultado.apiResult.message, /PC Gamer/);
    } finally {
      espiao.restaurar();
    }
  });

  it("não chama a API quando a oportunidade não tem contato", async () => {
    const espiao = espionar({});

    try {
      const resultado = await aplicarEtiquetas({
        ...BASE,
        contactId: "",
        sugeridas: [sugestao()],
      });

      assert.equal(espiao.chamadas.length, 0);
      assert.equal(resultado.status, "FALHOU");
    } finally {
      espiao.restaurar();
    }
  });

  /**
   * O caso que protege a página inteira: uma ação de escrita que falha não
   * pode virar erro 500 numa tela de análise.
   */
  it("transforma a recusa da API em resultado descrito, sem lançar", async () => {
    const espiao = espionar({
      erro: new ApiError({
        kind: "SEM_PERMISSAO",
        endpointKey: "CONTACTS_SET_TAGS",
        statusCode: 403,
        message: "POST CONTACTS_SET_TAGS respondeu 403.",
      }),
    });

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });

      assert.equal(resultado.status, "FALHOU");
      assert.equal(resultado.apiResult.ok, false);
      assert.match(resultado.apiResult.message, /403/, "o status HTTP precisa aparecer");
      assert.match(resultado.notice, /recusou/i);
    } finally {
      espiao.restaurar();
    }
  });

  it("não declara sucesso quando a API responde sem confirmar", async () => {
    const espiao = espionar({
      resposta: { applied: false, reason: "Contato nao encontrado." },
    });

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, sugeridas: [sugestao()] });

      assert.equal(resultado.status, "FALHOU");
      assert.match(resultado.notice, /Contato nao encontrado/);
    } finally {
      espiao.restaurar();
    }
  });
});
