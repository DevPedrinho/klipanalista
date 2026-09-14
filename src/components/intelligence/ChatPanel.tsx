"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/domain/types";
import { Button, Card, Input, Skeleton } from "@/components/ui/primitives";
import { cx } from "@/lib/format";

/**
 * Chat contextual com a Flowi IA.
 *
 * As respostas vem do servidor, montadas apenas com dados visiveis para
 * aquele usuario. Quando nao ha dados suficientes, a resposta diz isso
 * explicitamente — e a interface sinaliza.
 */

export function ChatPanel({
  messages,
  suggestions,
  sending,
  onSend,
  onCitationClick,
  compact = false,
}: {
  messages: ChatMessage[];
  suggestions: readonly string[];
  sending: boolean;
  onSend: (question: string) => void;
  onCitationClick?: (href: string) => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (trimmed.length === 0 || sending) return;
    onSend(trimmed);
    setDraft("");
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      {/* Mensagens */}
      <div
        className={cx(
          "flowi-scroll flex-1 space-y-4 overflow-y-auto p-4",
          compact ? "min-h-[240px]" : "min-h-[380px]",
        )}
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div
              className="flex h-11 w-11 items-center justify-center rounded-full flowi-gradient text-lg text-white"
              aria-hidden="true"
            >
              ✦
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                Converse com a Flowi IA
              </p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-text-muted">
                Pergunte sobre oportunidades, follow-ups, funil e qualidade do
                atendimento. As respostas usam apenas os dados que você pode ver.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cx(
                "flex",
                message.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cx(
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                  message.role === "user"
                    ? "flowi-gradient text-white"
                    : "bg-surface-muted text-text-secondary",
                )}
              >
                <MessageBody content={message.content} />

                {message.insufficientData ? (
                  <p className="mt-2 rounded-md bg-amber-100 px-2 py-1 text-[11px] text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                    Dados insuficientes para uma conclusão segura.
                  </p>
                ) : null}

                {message.citations && message.citations.length > 0 ? (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {message.citations.map((citation) => (
                      <button
                        key={`${citation.kind}-${citation.href}`}
                        type="button"
                        onClick={() => onCitationClick?.(citation.href)}
                        className="rounded-full bg-surface-card px-2 py-0.5 text-[11px] font-medium text-flowi-700 ring-1 ring-border-subtle hover:bg-flowi-50 dark:text-flowi-300"
                      >
                        {citation.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}

        {sending ? (
          <div className="flex justify-start">
            <div className="w-56 space-y-2 rounded-2xl bg-surface-muted px-3.5 py-2.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      {/* Sugestões */}
      {messages.length === 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border-subtle px-4 py-3">
          {suggestions.slice(0, compact ? 3 : 5).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => submit(suggestion)}
              disabled={sending}
              className="rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-flowi-300 hover:bg-flowi-50 disabled:opacity-50 dark:hover:bg-flowi-950/40"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      {/* Entrada */}
      <form
        className="flex items-center gap-2 border-t border-border-subtle p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Pergunte à Flowi IA..."
          aria-label="Pergunta para a Flowi IA"
          disabled={sending}
          maxLength={1000}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={sending || draft.trim().length === 0}
        >
          Enviar
        </Button>
      </form>
    </Card>
  );
}

/**
 * Renderiza o texto da resposta preservando quebras de linha e destacando
 * os trechos marcados com **negrito**. Nao interpreta HTML: o conteudo e
 * sempre tratado como texto.
 */
function MessageBody({ content }: { content: string }) {
  const lines = content.split("\n");

  return (
    <>
      {lines.map((line, lineIndex) => {
        if (line.trim() === "") {
          return <div key={lineIndex} className="h-2" />;
        }

        const parts = line.split(/(\*\*[^*]+\*\*)/g);
        return (
          <p key={lineIndex} className={lineIndex > 0 ? "mt-0.5" : undefined}>
            {parts.map((part, partIndex) =>
              part.startsWith("**") && part.endsWith("**") ? (
                <strong key={partIndex} className="font-semibold">
                  {part.slice(2, -2)}
                </strong>
              ) : (
                <span key={partIndex}>{part}</span>
              ),
            )}
          </p>
        );
      })}
    </>
  );
}
