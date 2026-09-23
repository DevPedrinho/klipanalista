# API KlipFlowi — o que já sabemos

Conhecimento medido contra a conta real na primeira versão do projeto (histórico do
git até o commit `87c1c36`). Documentação oficial: <https://flwchat.readme.io/llms.txt>
(acrescente `.md` à URL de uma página de referência para ler em markdown).

## Base e autenticação

- Host: `https://api.wts.chat`, caminhos no formato `/{grupo}/v{n}/{recurso}`.
- Grupos: `core` (contatos, etiquetas, atendentes, webhooks), `chat` (conversas,
  mensagens, notas), `crm` (painéis, cards). Usar o grupo errado dá 404.
- `Authorization: Bearer pn_...` — token permanente criado em
  *Configurações > Integrações > Integração API*.

## Erros

- Caminho inexistente → **401** com 404 no corpo (não confunda com token inválido).
- Caminho certo com parâmetro faltando → **500** com a mensagem dizendo o campo
  (ex.: `The PanelId field is required.`).
- 429/408/5xx: repetir com backoff e respeitar `Retry-After`.

## Paginação

- O parâmetro é **`pageNumber`**. `page` é ignorado em silêncio (devolve sempre a mesma página).
- `pageSize` funciona (usamos 50).
- Envelope: `{ items, totalPages, totalItems }`.
- Pare quando a página vier com menos itens que `pageSize` ou sem nenhum id novo.

## Conversas — `GET /chat/v2/session`

- Ordem **da mais antiga para a mais nova**. Nenhum filtro de data ou ordenação
  funcionou (12 variações testadas; `updatedAfter` é ignorado).
- Para pegar as recentes: ler a página 1 para saber `totalPages` e voltar de
  `totalPages` até 1, parando quando uma página inteira estiver antes do corte.
- Campos úteis: `id`, `contactId`, `userId` (atendente), `agentDetails.name`, `status`,
  `channelType`, `createdAt`, `startAt`, **`lastInteractionDate`** (recência real —
  `updatedAt` muda por qualquer motivo), `lastMessageIn`, `lastMessageOut`,
  `firstResponseAt`, `timeWait`, `timeService`, `previewUrl` (link do atendimento).
- `GET /chat/v2/session/{id}` busca uma conversa específica.

## Mensagens — `GET /chat/v1/session/{id}/message`

- Uma chamada (paginada) por conversa; a listagem de conversas não traz mensagens.
- **Quem falou:** `userId` preenchido = atendente; nulo = cliente. O campo
  `direction` vem como `FROM_HUB`/`TO_HUB` e não é confiável sozinho.
- **Áudio:** `text` vem nulo; a transcrição está em `details.transcription.text`, com
  as flags `details.transcription.processing` e `details.transcription.error`.
  Numa conversa de amostra, ~60% das mensagens eram áudio.
- Data: `createdAt`.

## Atendentes — `GET /core/v1/agent`

- `id`, `userId`, `name`, `email`, `profile` (`ADMIN` | `AGENT`), `isOwner`,
  `departments` (**array** de `{id, name}`), `companyId` (= a conta).

## Contatos — `GET /core/v1/contact/{id}`

- Busque **por id**. A listagem tem ~14 mil registros e também vem da mais antiga para a mais nova.
- `name`, `phoneNumber`, `email`, `tags`, `customFields`. Não há campo de empresa.

## Etiquetas — `POST /core/v1/contact/{id}/tags` (confirmado, em uso)

- Corpo `{ tagIds, operation }`, `operation` ∈ `InsertIfNotExists` | `DeleteIfExists` | `ReplaceAll`.
- Use só `InsertIfNotExists`. Nunca mande `tagNames` (cria etiqueta nova).

## CRM

- `GET /crm/v2/panel` — painéis. `type` ∈ `SALES` | `MANAGEMENT` (na conta real, 18 de 20
  eram "Minhas tarefas"). `steps` e `stepTitles` vêm **nulos**.
- `GET /crm/v1/panel/{id}` — detalhe; `steps` também nulo. Não existe endpoint de etapa.
- `GET /crm/v2/panel/card?PanelId=...` — **`PanelId` obrigatório** (sem ele: 500).
  Campos: `id`, `title`, `stepId`, `stepTitle`, `stepPhase` (muitas vezes nulos),
  `contactIds[]`, `monetaryAmount`, `status` (`OPEN`|`WON`|`LOST`|`ARCHIVED`),
  `responsibleUserId`, `lostReasonId`.
- As etapas de um painel são deduzidas dos cards (`stepId` distintos). Uma etapa com
  cards fechados e nenhum aberto é tratada como final.
- `GET /crm/v1/panel/{id}/lost-reason` — só em painéis SALES (nos outros, 500).
- `PUT /crm/v3/panel/card/{id}` — corpo com `fields` (lista dos campos alterados, enum
  com 14 valores ocultos na doc) + valores. **Não validado.**
- `POST /crm/v2/panel/card` — criar card. **Corpo não validado**; nomes deduzidos:
  `panelId`, `stepId`, `title`, `contactIds`, `responsibleUserId`, `monetaryAmount`.
- `GET|POST /crm/v1/panel/card/{cardId}/note` — anotações do card. **Corpo não validado**
  (provável `{ text }`).

## Não confirmado / desconhecido

- Endpoint de login integrado.
- Cabeçalho e algoritmo de assinatura dos webhooks.
- Limites de requisição (a doc cita 1000 envios a cada 2 minutos).
- `GET /v1/channel` devolve 401 com este tipo de token.
