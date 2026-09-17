"use client";

import type { ApiErrorBody } from "@/domain/types";
import { Button, Card, EmptyState, Notice, Skeleton } from "@/components/ui/primitives";

/**
 * Estados de interface exigidos pelo produto.
 *
 * Cada estado explica o que aconteceu e o que fazer a seguir — nunca
 * apenas "erro".
 */

export function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </Card>
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="p-4">
            <div className="flex gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Traduz o erro da API em uma tela acionavel. */
export function ErrorState({
  error,
  onRetry,
}: {
  error: ApiErrorBody;
  onRetry: () => void;
}) {
  const config = ERROR_CONFIG[error.code];

  return (
    <Card>
      <div className="p-6">
        <Notice tone={config.tone} title={config.title}>
          <p>{error.message}</p>
          <p className="mt-2">{config.hint}</p>

          {error.details ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium">
                Detalhes técnicos
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-card p-3 text-[11px] text-text-secondary">
                {JSON.stringify(error.details, null, 2)}
              </pre>
            </details>
          ) : null}

          {config.retryable ? (
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Tentar novamente
              </Button>
            </div>
          ) : null}
        </Notice>
      </div>
    </Card>
  );
}

type Tone = "info" | "warning" | "danger" | "success" | "pending";

const ERROR_CONFIG: Record<
  ApiErrorBody["code"],
  { title: string; hint: string; tone: Tone; retryable: boolean }
> = {
  NAO_AUTENTICADO: {
    title: "Token da API recusado",
    hint: "A KlipFlowi recusou a credencial. Verifique se o token (FLW_API_TOKEN) está correto e ainda é válido. Ele é gerado em Configurações > Integrações > Integração API.",
    tone: "danger",
    retryable: false,
  },
  USUARIO_NAO_ENCONTRADO: {
    title: "Usuário não encontrado nesta conta",
    hint: "A integração está funcionando — o que não confere é o userId do endereço. Abra a Central sem parâmetros para escolher seu nome na lista de usuários da conta.",
    tone: "warning",
    retryable: false,
  },
  SEM_PERMISSAO: {
    title: "Sem permissão",
    hint: "Seu perfil não permite acessar estes dados. Fale com um gestor ou administrador da conta.",
    tone: "warning",
    retryable: false,
  },
  PARAMETROS_INVALIDOS: {
    title: "Parâmetros inválidos",
    hint: "A página foi aberta sem os parâmetros obrigatórios (accountId e userId) ou com valores em formato inesperado. Verifique a configuração do menu personalizado na KlipFlowi.",
    tone: "warning",
    retryable: false,
  },
  SEM_INTEGRACAO: {
    title: "Integração não configurada",
    hint: "Preencha FLW_API_TOKEN, FLW_CORE_API_URL e FLW_CHAT_API_URL no arquivo .env.local e reinicie a aplicação. Enquanto isso, o módulo opera com dados simulados.",
    tone: "info",
    retryable: true,
  },
  ERRO_API: {
    title: "Erro de conexão com a API",
    hint: "A KlipFlowi respondeu com erro. As tentativas já foram repetidas automaticamente com espera progressiva.",
    tone: "danger",
    retryable: true,
  },
  LIMITE_REQUISICOES: {
    title: "Limite de requisições atingido",
    hint: "A API aplicou limite de chamadas. A fila retoma sozinha assim que a janela liberar — aguarde alguns instantes.",
    tone: "warning",
    retryable: true,
  },
  CONFLITO_DADOS: {
    title: "Conflito de dados",
    hint: "O registro mudou na plataforma desde a última leitura, ou uma regra da API impede esta operação. Atualize a análise e revise antes de tentar de novo.",
    tone: "warning",
    retryable: true,
  },
  AGUARDANDO_APROVACAO: {
    title: "Ação aguardando aprovação",
    hint: "Esta ação precisa da confirmação de um gestor ou administrador antes de ser aplicada.",
    tone: "pending",
    retryable: false,
  },
  CONTRATO_NAO_VALIDADO: {
    title: "Contrato de API ainda não validado",
    hint: "Este endpoint ainda não foi confirmado na documentação oficial. Por segurança, a chamada não é executada — ver /api/health para a lista completa de pendências.",
    tone: "pending",
    retryable: false,
  },
  ERRO_INTERNO: {
    title: "Erro inesperado",
    hint: "Algo falhou ao processar a solicitação. Se o problema persistir, verifique os logs do servidor.",
    tone: "danger",
    retryable: true,
  },
};

export function NoIntegrationBanner({ missing }: { missing: string[] }) {
  return (
    <Notice tone="info" title="Operando com dados simulados">
      <p>
        A integração com a API da KlipFlowi ainda não está ativa, então tudo o que você vê
        abaixo vem de um conjunto de dados de demonstração.
      </p>
      {missing.length > 0 ? (
        <p className="mt-1.5">
          Variáveis pendentes:{" "}
          <code className="rounded bg-surface-card px-1.5 py-0.5 text-[11px]">
            {missing.join(", ")}
          </code>
        </p>
      ) : null}
    </Notice>
  );
}

export function PendingValidationBanner({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <Notice tone="pending" title="Contratos de API pendentes de validação">
      <p>
        Os pontos abaixo ainda não foram confirmados na documentação oficial. Enquanto isso,
        as escritas correspondentes ficam bloqueadas de propósito.
      </p>
      <ul className="mt-1.5 list-inside list-disc space-y-0.5">
        {items.slice(0, 6).map((item) => (
          <li key={item} className="text-[12px]">
            {item}
          </li>
        ))}
      </ul>
      {items.length > 6 ? (
        <p className="mt-1 text-[11px] opacity-80">
          e mais {items.length - 6} item(ns). Consulte <code>/api/health</code>.
        </p>
      ) : null}
    </Notice>
  );
}

/**
 * Fontes que falharam sem derrubar a analise.
 *
 * Existe para o momento da primeira conexao com a API real: em vez de uma tela
 * de erro generica, o usuario ve exatamente qual fonte falhou e por que, e o
 * resto da Central continua utilizavel.
 */
export function SourceFailuresBanner({
  failures,
}: {
  failures: { source: string; endpoint?: string; kind: string; message: string }[];
}) {
  if (failures.length === 0) return null;

  const explicacao: Record<string, string> = {
    NAO_AUTENTICADO: "O token da API foi recusado. Confira FLW_API_TOKEN.",
    SEM_PERMISSAO: "O token não tem permissão para este recurso.",
    NAO_ENCONTRADO:
      "O endereço do endpoint não existe nesta conta. Provavelmente o prefixo de serviço está errado.",
    LIMITE_REQUISICOES: "Limite de requisições atingido. A fila retoma sozinha.",
    SEM_INTEGRACAO: "Faltam variáveis de ambiente para esta chamada.",
    CONTRATO_NAO_VALIDADO: "Este endpoint ainda não foi confirmado na documentação.",
    TIMEOUT: "A API demorou demais para responder.",
    ERRO_REDE: "Não foi possível alcançar a API.",
    PARCIAL: "Parte dos dados não carregou.",
  };

  return (
    <Notice tone="warning" title="Parte dos dados não carregou">
      <p>
        A análise continuou com o que foi possível obter. O que falhou está abaixo —
        os números exibidos não incluem essas fontes.
      </p>
      <ul className="mt-2 space-y-1.5">
        {failures.map((f) => (
          <li key={`${f.source}-${f.kind}`}>
            <span className="font-semibold">{f.source}</span>
            {f.endpoint ? (
              <code className="ml-1.5 rounded bg-surface-card px-1.5 py-0.5 text-[11px]">
                {f.endpoint}
              </code>
            ) : null}
            <span className="mt-0.5 block text-[12px] opacity-90">
              {explicacao[f.kind] ?? f.message}
            </span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

export function NoOpportunities({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <Card>
      <EmptyState
        title="Nenhuma oportunidade encontrada"
        description="Nenhuma conversa atingiu o corte mínimo de 30 pontos com os filtros atuais. Tente ampliar o período ou remover o filtro de equipe e vendedor."
        action={
          <Button variant="secondary" size="sm" onClick={onClearFilters}>
            Limpar filtros
          </Button>
        }
      />
    </Card>
  );
}

export function AnalysisRunning() {
  return (
    <Notice tone="info" title="Análise em processamento">
      A Flowi IA está reprocessando os atendimentos do período. Os números são atualizados
      assim que a análise terminar.
    </Notice>
  );
}
