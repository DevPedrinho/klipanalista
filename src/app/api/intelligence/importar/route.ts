import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, failValidation, handleError, ok } from "@/server/http/respond";
import { getIntegrationReadiness } from "@/server/config/env";
import {
  PlanilhaInvalida,
  lerPlanilha,
} from "@/server/import/xlsx-reader";
import {
  lerVocabularioDaDirecao,
  proporMapeamento,
} from "@/server/import/mapeamento";
import { normalizarPlanilha } from "@/server/import/normalizar";
import type { Mapeamento } from "@/server/import/mapeamento";

/**
 * POST /api/intelligence/importar
 *
 * Recebe o relatorio `.xlsx` exportado da KlipFlowi e devolve as conversas
 * normalizadas — sem analisar e sem tocar no CRM.
 *
 * DOIS PASSOS NA MESMA ROTA
 *
 * Sem `mapeamento`, responde com cabecalhos, amostra e a PROPOSTA de
 * mapeamento: e o passo em que a pessoa confere de que coluna sai cada coisa.
 * Com `mapeamento` confirmado, responde com as conversas prontas para a
 * analise.
 *
 * ONDE OS DADOS FICAM
 *
 * Em lugar nenhum. A rota nao guarda o arquivo nem as conversas: devolve tudo
 * para o navegador, que segura enquanto a analise avanca em lotes. Nao e
 * elegancia — e que auditoria e configuracoes ainda vivem em memoria e somem
 * no cold start da Vercel, entao nao ha onde guardar estado entre requisicoes.
 * O navegador e o unico lugar que sobrevive.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Teto do corpo da requisicao.
 *
 * A Vercel recusa corpo acima de ~4,5 MB antes de o codigo rodar, e o erro que
 * ela devolve nao diz o que aconteceu. Conferir aqui troca uma falha opaca de
 * plataforma por uma frase que diz o tamanho recebido e o limite.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

const mapeamentoSchema = z.record(z.string(), z.string()).optional();
const direcoesSchema = z
  .record(z.string(), z.enum(["INBOUND", "OUTBOUND"]))
  .optional();

const campoSchema = z.object({
  accountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  aba: z.string().max(200).optional(),
});

/** Quantas linhas voltam como amostra no passo de mapeamento. */
const LINHAS_DE_AMOSTRA = 8;

export async function POST(request: NextRequest) {
  try {
    const readiness = getIntegrationReadiness();

    const form = await request.formData().catch(() => null);
    if (!form) {
      return fail(
        "PARAMETROS_INVALIDOS",
        "Envie o arquivo como multipart/form-data, no campo `arquivo`.",
      );
    }

    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof File)) {
      return fail("PARAMETROS_INVALIDOS", "Nenhum arquivo foi enviado no campo `arquivo`.");
    }

    if (arquivo.size > MAX_BYTES) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      return fail(
        "PARAMETROS_INVALIDOS",
        `A planilha tem ${mb(arquivo.size)} MB e o limite por envio e ${mb(MAX_BYTES)} MB. ` +
          `Exporte um periodo menor e importe em partes — a analise soma os envios.`,
      );
    }

    const parsed = campoSchema.safeParse({
      accountId: form.get("accountId"),
      ...(form.get("aba") ? { aba: form.get("aba") } : {}),
    });
    if (!parsed.success) return failValidation(parsed.error.issues);

    const buffer = Buffer.from(await arquivo.arrayBuffer());

    const planilha = await lerPlanilha(buffer, {
      ...(parsed.data.aba ? { aba: parsed.data.aba } : {}),
    });

    const proposta = proporMapeamento(planilha.cabecalhos, planilha.linhas);

    /* --- Passo 1: a pessoa ainda precisa confirmar o mapeamento ----------- */
    const mapeamentoBruto = mapeamentoSchema.safeParse(
      form.get("mapeamento") ? JSON.parse(String(form.get("mapeamento"))) : undefined,
    );
    if (!mapeamentoBruto.success) return failValidation(mapeamentoBruto.error.issues);

    const mapeamento = mapeamentoBruto.data as Mapeamento | undefined;

    const colunaDirecao = mapeamento?.direcao ?? proposta.mapeamento.direcao;
    const vocabulario = colunaDirecao
      ? lerVocabularioDaDirecao(
          planilha.linhas.map((l) => l.valores[colunaDirecao] ?? ""),
        )
      : { valores: [], precisaConfirmar: true };

    if (!mapeamento) {
      return ok(
        {
          etapa: "MAPEAR" as const,
          abas: planilha.abas,
          abaLida: planilha.abaLida,
          cabecalhos: planilha.cabecalhos,
          totalDeLinhas: planilha.linhas.length,
          linhasVazias: planilha.linhasVazias,
          amostra: planilha.linhas.slice(0, LINHAS_DE_AMOSTRA),
          proposta,
          vocabularioDaDirecao: vocabulario,
        },
        { dataMode: readiness.dataMode },
      );
    }

    /* --- Passo 2: mapeamento confirmado, normaliza ------------------------ */
    const direcoesBrutas = direcoesSchema.safeParse(
      form.get("direcoes") ? JSON.parse(String(form.get("direcoes"))) : undefined,
    );
    if (!direcoesBrutas.success) return failValidation(direcoesBrutas.error.issues);

    /*
     * Sem confirmacao explicita, vale o que o vocabulario conhecido reconheceu
     * — e apenas ele. Valor nao reconhecido fica de fora e a linha e rejeitada
     * com nome, em vez de cair num lado por padrao: trocar os lados atribui
     * cada fala do cliente a equipe e inverte a analise inteira.
     */
    const direcoes: Record<string, "INBOUND" | "OUTBOUND"> = { ...(direcoesBrutas.data ?? {}) };
    for (const { valor, lado } of vocabulario.valores) {
      if (lado !== "DESCONHECIDO" && direcoes[valor] === undefined) direcoes[valor] = lado;
    }

    const resultado = normalizarPlanilha(planilha.linhas, {
      accountId: parsed.data.accountId,
      mapeamento,
      direcoes,
    });

    return ok(
      {
        etapa: "NORMALIZADO" as const,
        abaLida: planilha.abaLida,
        totalDeLinhas: planilha.linhas.length,
        ...resultado,
      },
      { dataMode: readiness.dataMode },
    );
  } catch (error) {
    if (error instanceof PlanilhaInvalida) {
      return fail("PARAMETROS_INVALIDOS", error.message);
    }
    if (error instanceof SyntaxError) {
      return fail("PARAMETROS_INVALIDOS", "O mapeamento enviado nao e um JSON valido.");
    }
    return handleError(error);
  }
}
