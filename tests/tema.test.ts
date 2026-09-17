import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Integridade da paleta.
 *
 * Um defeito real e silencioso motivou este arquivo: os componentes usavam
 * `dark:bg-flowi-950/40` e `dark:bg-violet-brand-950/40` em oito lugares, mas
 * o passo 950 nunca foi definido — as duas escalas iam so ate 900.
 *
 * O Tailwind nao reclama de um utilitario que nao existe: ele simplesmente
 * nao o gera. A classe some, o fundo CLARO do tema claro permanece no tema
 * escuro, e o texto continua sendo o `-100`, quase branco. O painel de
 * diagnostico ficou com contraste de 1.10:1 — texto invisivel — sem nenhum
 * erro de build, de tipo ou de lint.
 *
 * Nenhuma dessas ferramentas pega isso. Este teste pega.
 */

const RAIZ = join(import.meta.dirname, "..", "src");
const CSS = readFileSync(join(RAIZ, "app", "globals.css"), "utf8");

/** Escalas proprias do projeto; as do Tailwind ja vem completas. */
const ESCALAS_PROPRIAS = ["flowi", "violet-brand"];

function arquivosDeComponente(dir: string): string[] {
  const encontrados: string[] = [];

  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      encontrados.push(...arquivosDeComponente(caminho));
      continue;
    }
    if (/\.(tsx|ts|css)$/.test(nome)) encontrados.push(caminho);
  }

  return encontrados;
}

/** Todos os passos citados no codigo, por escala. */
function passosUsados(): Map<string, Set<string>> {
  const usados = new Map<string, Set<string>>(
    ESCALAS_PROPRIAS.map((escala) => [escala, new Set<string>()]),
  );

  for (const arquivo of arquivosDeComponente(RAIZ)) {
    const conteudo = readFileSync(arquivo, "utf8");

    for (const escala of ESCALAS_PROPRIAS) {
      // Captura bg-flowi-950, dark:text-violet-brand-100/40, ring-flowi-200...
      const padrao = new RegExp(`${escala}-(\\d{2,3})`, "g");
      let achado: RegExpExecArray | null;

      while ((achado = padrao.exec(conteudo)) !== null) {
        const passo = achado[1];
        if (passo) usados.get(escala)?.add(passo);
      }
    }
  }

  return usados;
}

describe("paleta do tema", () => {
  it("todo passo de cor usado no codigo existe no @theme", () => {
    const usados = passosUsados();
    const faltando: string[] = [];

    for (const [escala, passos] of usados) {
      for (const passo of passos) {
        const token = `--color-${escala}-${passo}:`;
        if (!CSS.includes(token)) faltando.push(`${escala}-${passo}`);
      }
    }

    assert.deepEqual(
      faltando,
      [],
      `Passos usados no codigo e ausentes do @theme: ${faltando.join(", ")}. ` +
        `O Tailwind descarta o utilitario em silencio — a classe some e a cor ` +
        `do outro tema permanece, o que ja produziu texto claro sobre fundo claro.`,
    );
  });

  it("as escalas cobrem de 50 a 950, que e o que o tema escuro usa", () => {
    const esperados = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

    for (const escala of ESCALAS_PROPRIAS) {
      for (const passo of esperados) {
        assert.ok(
          CSS.includes(`--color-${escala}-${passo}:`),
          `falta --color-${escala}-${passo} em globals.css`,
        );
      }
    }
  });

  /**
   * O 950 e o fundo de TODA superficie `dark:bg-*-950/40` do app. Quando ele
   * nao existia, oito superficies quebravam juntas — o painel de diagnostico
   * foi so a mais visivel.
   */
  it("o passo 950 e escuro o bastante para servir de fundo no tema escuro", () => {
    for (const escala of ESCALAS_PROPRIAS) {
      const achado = new RegExp(`--color-${escala}-950:\\s*#([0-9a-f]{6})`, "i").exec(CSS);
      assert.ok(achado, `--color-${escala}-950 precisa estar definido`);

      const hex = achado[1];
      assert.ok(hex);

      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);

      // Luminancia relativa simplificada: um fundo escuro fica bem abaixo disso.
      const brilho = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

      assert.ok(
        brilho < 0.25,
        `${escala}-950 (#${hex}) esta claro demais (${brilho.toFixed(2)}) para ser ` +
          `fundo de texto claro no tema escuro`,
      );
    }
  });
});
