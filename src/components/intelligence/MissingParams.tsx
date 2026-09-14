import { Card, Notice } from "@/components/ui/primitives";

/**
 * Estado exibido quando a página é aberta sem os parâmetros obrigatórios.
 * Explica exatamente como configurar o menu ou a ação na KlipFlowi.
 */
export function MissingParams({
  missing,
  context,
}: {
  missing: string[];
  context: "central" | "widget";
}) {
  const isWidget = context === "widget";

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <Card className="p-6">
        <h1 className="text-lg font-semibold text-text-primary">
          Parâmetros obrigatórios ausentes
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {isWidget
            ? "O widget contextual precisa saber de qual conta, usuário e atendimento foi aberto."
            : "A Central de Inteligência Comercial precisa saber de qual conta e usuário está sendo aberta."}
        </p>

        <div className="mt-4">
          <Notice tone="warning" title="Faltando na URL">
            <ul className="list-inside list-disc space-y-0.5">
              {missing.map((item) => (
                <li key={item}>
                  <code className="text-[12px]">{item}</code>
                </li>
              ))}
            </ul>
          </Notice>
        </div>

        <div className="mt-5">
          <h2 className="text-sm font-semibold text-text-primary">
            Como configurar na KlipFlowi
          </h2>

          {isWidget ? (
            <ol className="mt-2 space-y-2 text-sm text-text-secondary">
              <li>
                1. Acesse <strong>Configurações &gt; Ações personalizadas</strong>.
              </li>
              <li>2. Crie uma ação do tipo popup dentro do atendimento e/ou do CRM.</li>
              <li>
                3. Informe a URL abaixo, usando as variáveis que a plataforma disponibiliza:
              </li>
            </ol>
          ) : (
            <ol className="mt-2 space-y-2 text-sm text-text-secondary">
              <li>
                1. Acesse <strong>Configurações &gt; Menus personalizados</strong>.
              </li>
              <li>2. Crie um menu que abre uma página interna.</li>
              <li>3. Informe a URL abaixo com os parâmetros da conta e do usuário:</li>
            </ol>
          )}

          <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-muted p-3 text-[12px] leading-relaxed text-text-secondary">
            {isWidget
              ? "/inteligencia-comercial/widget\n  ?accountId={accountId}\n  &userId={userId}\n  &contactId={contactId}\n  &sessionId={sessionId}\n  &cardId={cardId}\n  &origin=atendimento"
              : "/inteligencia-comercial\n  ?accountId={accountId}\n  &userId={userId}"}
          </pre>

          <p className="mt-3 text-xs text-text-muted">
            Os nomes exatos das variáveis que a KlipFlowi substitui na URL precisam ser
            confirmados na documentação de ações e menus personalizados.
          </p>
        </div>
      </Card>
    </main>
  );
}
