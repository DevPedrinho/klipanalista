import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contactsAdapter, tagsAdapter } from "@/server/integration/adapters";
import { ApiError } from "@/server/integration/http/client";
import { aplicarEtiquetas } from "@/server/services/tag-application.service";
import type { Tag } from "@/domain/types";

/**
 * Aplicação de etiquetas — a primeira escrita real na API.
 *
 * Até aqui o módulo só lia. Esta é a primeira ação que altera a conta do
 * cliente, então o que ela NÃO faz importa tanto quanto o que faz:
 *
 *   - não cria etiqueta que não existe (isso exige aprovação administrativa);
 *   - não substitui as etiquetas que a equipe marcou à mão;
 *   - não derruba a página quando a API recusa.
 *
 * Os adapters são substituídos por espiões: estes testes verificam a decisão,
 * não a rede.
 */

const ETIQUETAS_DA_CONTA: Tag[] = [
  { id: "t_quente", accountId: "acc1", name: "IA | Oportunidade quente" },
  { id: "t_urgencia", accountId: "acc1", name: "IA | Urgencia" },
];

interface Chamada {
  contactId: string;
  tagIds?: string[];
  tagNames?: string[];
  dryRun: boolean;
}

/**
 * Troca os dois adapters por espiões e devolve as chamadas registradas junto
 * com a forma de restaurar o original.
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
      data: options.resposta ?? { applied: true, tagIds: ["t_quente", "t_urgencia"] },
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
  it("envia ao contato apenas as etiquetas que já existem na conta", async () => {
    const espiao = espionar({});

    try {
      const resultado = await aplicarEtiquetas({
        ...BASE,
        // RECOMPRA não existe na conta: não pode ser enviada.
        tagKeys: ["OPORTUNIDADE_QUENTE", "URGENCIA", "RECOMPRA"],
      });

      assert.equal(resultado.status, "EXECUTADA");
      assert.equal(espiao.chamadas.length, 1, "uma única chamada à API");

      const enviadas = espiao.chamadas[0]?.tagIds ?? [];
      assert.deepEqual(
        [...enviadas].sort(),
        ["t_quente", "t_urgencia"],
        "só as etiquetas resolvidas contra a conta",
      );
    } finally {
      espiao.restaurar();
    }
  });

  it("nunca envia nome de etiqueta inexistente para ser criada", async () => {
    const espiao = espionar({});

    try {
      await aplicarEtiquetas({ ...BASE, tagKeys: ["RECOMPRA", "OPORTUNIDADE_QUENTE"] });

      const chamada = espiao.chamadas[0];
      assert.ok(chamada, "deveria ter chamado a API");
      assert.equal(
        chamada.tagNames,
        undefined,
        "enviar `tagNames` faria a plataforma criar etiqueta sem aprovação",
      );
    } finally {
      espiao.restaurar();
    }
  });

  it("escreve de verdade: dryRun é falso", async () => {
    const espiao = espionar({});

    try {
      await aplicarEtiquetas({ ...BASE, tagKeys: ["URGENCIA"] });
      assert.equal(espiao.chamadas[0]?.dryRun, false);
    } finally {
      espiao.restaurar();
    }
  });

  it("registra no resultado a lista que a API confirmou, não a que pedimos", async () => {
    const espiao = espionar({
      resposta: { applied: true, tagIds: ["t_quente", "t_urgencia", "t_manual_da_equipe"] },
    });

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, tagKeys: ["URGENCIA"] });

      assert.deepEqual(resultado.depois?.["etiquetasNoContatoDepois"], [
        "t_quente",
        "t_urgencia",
        "t_manual_da_equipe",
      ]);
    } finally {
      espiao.restaurar();
    }
  });
});

describe("aplicar etiquetas — o que ela recusa fazer", () => {
  it("não chama a API quando nenhuma etiqueta recomendada existe na conta", async () => {
    const espiao = espionar({ etiquetas: [] });

    try {
      const resultado = await aplicarEtiquetas({
        ...BASE,
        tagKeys: ["OPORTUNIDADE_QUENTE"],
      });

      assert.equal(espiao.chamadas.length, 0, "chamada inútil à API");
      assert.equal(resultado.status, "FALHOU");
      assert.match(
        resultado.notice,
        /aprovacao administrativa/i,
        "a tela precisa explicar por que nada foi aplicado",
      );
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
        tagKeys: ["URGENCIA"],
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
        message: "GET CONTACTS_SET_TAGS respondeu 403.",
      }),
    });

    try {
      const resultado = await aplicarEtiquetas({ ...BASE, tagKeys: ["URGENCIA"] });

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
      const resultado = await aplicarEtiquetas({ ...BASE, tagKeys: ["URGENCIA"] });

      assert.equal(resultado.status, "FALHOU");
      assert.match(resultado.notice, /Contato nao encontrado/);
    } finally {
      espiao.restaurar();
    }
  });
});
