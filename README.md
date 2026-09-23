# Klip Analista

Módulo da **KlipFlowi** que puxa os atendimentos pela API, **incluindo a transcrição dos
áudios**, guarda tudo no Supabase e prepara a base para priorizar leads.

Stack: Next.js (App Router) · Vercel · Supabase (schema `klip`).

## Módulos

| Módulo | Situação |
|---|---|
| [01 — Listar Atendimentos](docs/modulos/01-listar-atendimentos.md) | ✅ implementado |
| 02 — Priorizar leads (score/IA sobre os dados salvos) | próximo |
| 03 — Painel do funil (menu personalizado) | planejado |
| 04 — Popup de atendimento + etiquetas | planejado |

Tudo o que já foi medido na API da KlipFlowi está em [docs/api-klipflowi.md](docs/api-klipflowi.md).
A primeira versão do projeto (Flowi Copilot Comercial) está no histórico do git, até o commit `87c1c36`.

## Como rodar

```bash
cp .env.example .env.local   # preencha as variáveis
npm install
npm run dev                  # http://localhost:3000/atendimentos
```

```bash
npm test          # testes (vitest)
npm run verify    # typecheck + lint + testes + build — rode antes de publicar
```

## Banco

As migrações ficam em `supabase/migrations/` e criam tudo no schema **`klip`**.
No painel do Supabase, em *Settings → Data API → Exposed schemas*, adicione `klip`.

## Publicação (Vercel)

1. Configure as variáveis de `.env.example` no projeto da Vercel.
2. O cron diário (`vercel.json`, 06:00 de Brasília) sincroniza sozinho. O botão
   “Sincronizar agora” faz o mesmo sob demanda.
3. Na KlipFlowi, crie um **menu personalizado** apontando para
   `https://<seu-app>.vercel.app/atendimentos?accountId=<FLW_ACCOUNT_ID>&chave=<APP_CHAVE_ACESSO>`.
