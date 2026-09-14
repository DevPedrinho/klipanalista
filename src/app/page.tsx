import Link from "next/link";

/**
 * Página inicial: serve apenas como ponto de entrada para desenvolvimento.
 * Em produção, o acesso acontece pelo menu personalizado da KlipFlowi,
 * que abre /inteligencia-comercial já com os parâmetros da conta.
 */
export default function Home() {
  const demoParams = "accountId=acc_klipflowi_demo&userId=user_carla";

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
              href={`/inteligencia-comercial?${demoParams}`}
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
              href={`/inteligencia-comercial/widget?${demoParams}&sessionId=sess_001&origin=atendimento`}
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
              href={`/inteligencia-comercial/configuracoes?${demoParams}`}
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
        Os links acima usam a conta de demonstração. Em produção, accountId e userId são
        injetados pela KlipFlowi ao abrir o menu personalizado.
      </p>
    </main>
  );
}
