import Link from "next/link";
import type { AppUser } from "@/domain/types";

/**
 * Escolha de quem esta usando a Central.
 *
 * Por que existe: a Central precisa saber QUEM esta olhando, porque o perfil
 * define o escopo — um vendedor ve os proprios atendimentos, um gestor ve a
 * equipe, um administrador ve a conta inteira. Esse dado chega pela URL
 * quando a KlipFlowi abre a pagina pelo menu personalizado.
 *
 * Fora dali — abrindo o endereco direto, como qualquer pessoa faria — nao ha
 * nada na URL. A versao anterior respondia a isso com um erro de
 * autenticacao sugerindo conferir o token, que e uma pista falsa: o token
 * estava certo, faltava dizer quem era a pessoa.
 *
 * Como o token ja define a conta, o modulo pode simplesmente perguntar. E o
 * que esta tela faz.
 */

const ROTULO_DE_PERFIL: Record<AppUser["role"], string> = {
  ADMIN: "Administrador — vê a conta inteira",
  GESTOR: "Gestor — vê a própria equipe",
  VENDEDOR: "Vendedor — vê os próprios atendimentos",
};

export interface SeletorDeUsuarioProps {
  accountId: string;
  usuarios: AppUser[];
  /** Por que a tela apareceu, para nao deixar a pessoa adivinhando. */
  motivo: "SEM_PARAMETRO" | "USUARIO_NAO_ENCONTRADO";
  /** Id que veio na URL e nao foi encontrado. */
  userIdInformado?: string;
  /** Para onde levar depois de escolher. */
  destino?: string;
}

export function SeletorDeUsuario({
  accountId,
  usuarios,
  motivo,
  userIdInformado,
  destino = "/inteligencia-comercial",
}: SeletorDeUsuarioProps) {
  const ativos = usuarios.filter((u) => u.active);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-flowi-600">
          KlipFlowi
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight flowi-gradient-text sm:text-3xl">
          Quem está usando a Central?
        </h1>

        {motivo === "USUARIO_NAO_ENCONTRADO" ? (
          <p className="mt-3 leading-relaxed text-text-secondary">
            O usuário{" "}
            <code className="rounded bg-surface-card px-1.5 py-0.5 text-xs">
              {userIdInformado}
            </code>{" "}
            não existe nesta conta. A integração está funcionando — abaixo estão as
            pessoas que a API realmente retornou.
          </p>
        ) : (
          <p className="mt-3 leading-relaxed text-text-secondary">
            A Central mostra resultados diferentes conforme o perfil de quem olha.
            Escolha seu nome para continuar.
          </p>
        )}
      </div>

      {ativos.length === 0 ? (
        <div className="rounded-xl border border-border-subtle bg-surface-card p-5">
          <p className="text-sm text-text-secondary">
            A API respondeu, mas não retornou nenhum usuário ativo nesta conta. Sem
            saber quem está olhando, não há como definir o que mostrar — a Central
            não abre sem isso, de propósito.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {ativos.map((usuario) => (
            <li key={usuario.id}>
              <Link
                href={`${destino}?accountId=${encodeURIComponent(
                  accountId,
                )}&userId=${encodeURIComponent(usuario.id)}`}
                className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-surface-card px-5 py-4 transition hover:border-flowi-600"
              >
                <span>
                  <span className="block font-medium text-text-primary">
                    {usuario.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {ROTULO_DE_PERFIL[usuario.role]}
                    {usuario.teamName ? ` · ${usuario.teamName}` : ""}
                  </span>
                </span>
                <span aria-hidden className="text-flowi-600">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-text-muted">
        Esta tela é do uso avulso. Dentro da KlipFlowi, o menu personalizado abre a
        Central já sabendo quem é a pessoa, e ela não aparece.
      </p>
    </main>
  );
}
