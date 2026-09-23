# Módulo 01 — Listar Atendimentos

**Objetivo:** ter todas as conversas da KlipFlowi no nosso banco, com o texto das mensagens
e a **transcrição dos áudios**, para que nada passe despercebido e o Módulo 02 possa
priorizar leads sem depender da API ao vivo.

## O que faz

- **Sincronização** KlipFlowi → Supabase (`src/lib/sync/`).
  - Fases: atendentes → conversas → mensagens → contatos.
  - Roda em rodadas de ~40s (`POST /api/sync`), com o estado salvo em `klip.sync_runs`,
    então cabe no limite de 60s da Vercel Hobby.
  - Janela: conversas com interação nos últimos `SYNC_JANELA_DIAS` dias (padrão 7).
  - A API lista da mais antiga para a mais nova e não filtra por data: lemos da última
    página para trás até uma página inteira ficar fora da janela.
  - Áudio com transcrição ainda em processamento mantém a conversa pendente; ela é
    buscada de novo na próxima sincronização.
  - Cron diário (`/api/cron/sync`), que encadeia rodadas até terminar e aplica a retenção.
- **`/atendimentos`**: lista com filtros (contato/telefone, atendente, status, período,
  com áudio, transcrição pendente), botão “Sincronizar agora” e “Abrir atendimento”.
- **`/atendimentos/[id]`**: conversa completa, com áudios transcritos, e o painel de CRM:
  - **Criar card no CRM** (painel → etapa → título, valor, responsável), com revisão antes de gravar.
  - **Anotações do card**: listar e criar, com atalho “Inserir resumo da conversa”.
- **`/configuracoes`**: histórico das sincronizações, espaço ocupado e **limpeza do banco**
  (apagar conversas antigas ou tudo; exige digitar `APAGAR`). Só apaga dados deste app.

## Acesso

O app só abre com `?accountId=` igual a `FLW_ACCOUNT_ID` e, se configurada, `?chave=`
igual a `APP_CHAVE_ACESSO`. Depois disso vale um cookie de 12h (particionado, funciona no
iframe). Perfis (vendedor/gestor/admin) ficam para um módulo seguinte.

## Pendências conhecidas

- **Criar card** (`POST /crm/v2/panel/card`) e **criar anotação**
  (`POST /crm/v1/panel/card/{id}/note`) usam corpos deduzidos; é preciso validar com um
  primeiro uso real em um painel de teste. Se a API recusar, a mensagem completa dela
  aparece na tela.
- Painel sem nenhum card não mostra etapas (a API não as informa).
- Conversa criada antes da janela que voltou a ter mensagens pode ficar numa página antiga
  e não ser vista. A solução completa é via webhooks, num módulo futuro.
