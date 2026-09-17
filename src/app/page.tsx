import Link from "next/link";
import { getIntegrationReadiness } from "@/server/config/env";

/**
 * Página inicial: ponto de entrada fora da KlipFlowi.
 * Em produção, o acesso acontece pelo menu personalizado da plataforma,
 * que abre /inteligencia-comercial já com os parâmetros da conta.
 */

export const dynamic = "force-dynamic";

export default function Home() {
  const integracao = getIntegrationReadiness();

  /*
   * Os ids de demonstração só existem no conjunto simulado. Com a integração
   * real ligada, mandar alguém para `userId=user_carla` produz "usuário não
   * encontrado nesta conta" — um erro que parece falha de integração e não é.
   * Foi exatamente o que aconteceu ao abrir estes links contra a conta real.
   *
   * Com integração real, os links vão sem parâmetro: a própria Central
   * pergunta quem está usando, a partir dos usuários que a API retorna.
   */
  const demoParams = integracao.ready
    ? ""
    : "accountId=acc_klipflowi_demo&userId=user_carla";

  const comParams = (rota: string, extra = "") => {
    const query = [demoParams, extra].filter(Boolean).join("&");
    return query ? `${rota}?${query}` : rota;
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-flowi-600">
          KlipFlowi
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight flowi-gradient-text sm:text-4xl">
          Flowi Copilot Comercial
        </h1>
        <p className="mt-2 text-lg text-text-secondary">
          Seu consultor de CRM e inteligência comercial.
        </p>
        <p className="mt-4 max-w-2xl leading-relaxed text-text-muted">
          A Flowi IA analisa os atendimentos, identifica oportunidades e orienta sua equipe
          sobre o próximo passo para transformar conversas em vendas.
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface-card p-5 shadow-[var(--shadow-card)]">
        <h2 className="text-sm font-semibold text-text-primary">
          Rotas disponíveis
        </h2>
        <ul className="mt-3 space-y-3 text-sm">
          <li>
            <Link
              href={comParams("/inteligencia-comercial")}
              className="font-medium text-flowi-600 hover:underline dark:text-flowi-300"
            >
              /inteligencia-comercial
            </Link>
            <p className="mt-0.5 text-xs text-text-muted">
              Central de Inteligência Comercial. Incorporada como página interna em um
              menu personalizado da KlipFlowi.
            </p>
          </li>
          <li>
            <Link
              href={comParams(
                "/inteligencia-comercial/widget",
                "sessionId=sess_001&origin=atendimento",
              )}
              className="font-medium text-flowi-600 hover:underline dark:text-flowi-300"
            >
              /inteligencia-comercial/widget
            </Link>
            <p className="mt-0.5 text-xs text-text-muted">
              Widget contextual. Aberto em popup por uma ação personalizada dentro do
              atendimento ou do CRM.
            </p>
          </li>
          <li>
            <Link
              href={comParams("/inteligencia-comercial/configuracoes")}
              className="font-medium text-flowi-600 hover:underline dark:text-flowi-300"
            >
              /inteligencia-comercial/configuracoes
            </Link>
            <p className="mt-0.5 text-xs text-text-muted">
              Modos de automação, taxonomia de etiquetas e estado da integração.
            </p>
          </li>
          <li>
            <a
              href="/api/health"
              className="font-medium text-flowi-600 hover:underline dark:text-flowi-300"
            >
              /api/health
            </a>
            <p className="mt-0.5 text-xs text-text-muted">
              Diagnóstico: o que está configurado e quais contratos de API continuam
              pendentes de validação.
            </p>
          </li>
        </ul>
      </div>

      <p className="text-xs leading-relaxed text-text-muted">
        {integracao.ready
          ? "A integração está ligada: os links abrem com os dados reais da conta e a Central pergunta quem está usando. Dentro da KlipFlowi, accountId e userId são injetados pelo menu personalizado."
          : "Sem credencial configurada, os links usam a conta de demonstração. Em produção, accountId e userId são injetados pela KlipFlowi ao abrir o menu personalizado."}
      </p>
    </main>
  );
}
