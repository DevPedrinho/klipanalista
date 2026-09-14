# Flowi Copilot Comercial

> **Seu consultor de CRM e inteligência comercial.**
> A Flowi IA analisa os atendimentos, identifica oportunidades e orienta sua equipe
> sobre o próximo passo para transformar conversas em vendas.

Módulo da **KlipFlowi** que roda como aplicação própria e é incorporado à plataforma
por um **menu personalizado** (página interna) e por uma **ação personalizada** (popup).

---

## ⚠️ Leia antes de tudo

Esta é a **primeira entrega**. O que está e o que não está funcionando:

| | Situação |
|---|---|
| ✅ Interface, motor de score, auditoria, modos de automação | **Funcionando e testado** |
| ✅ Autenticação da API (`Authorization: Bearer pn_...`) | **Confirmada na documentação oficial** |
| ✅ Caminhos dos endpoints de leitura | **Extraídos do índice oficial da documentação** |
| 🟡 Dados exibidos | **Simulados.** Nenhuma chamada real à API foi feita ou testada |
| 🔴 Escrita no CRM (criar/atualizar card, aplicar etiqueta) | **Bloqueada de propósito** — contratos não validados |
| 🔴 Envio de mensagem ao cliente | **Não implementado** — exige confirmação humana sempre |

**Nenhuma integração foi testada contra a API real.** Tudo que a interface mostra
vem de `src/mocks/dataset.ts`. As seções abaixo explicam exatamente o que falta.

---

## Como rodar

```bash
npm install
npm run dev
```

Abra <http://localhost:3000> — a página inicial lista as rotas com a conta de demonstração.

Outros comandos:

```bash
npm run build           # build de produção
npm run typecheck       # checagem de tipos
npm run lint            # ESLint
npm run verify:scoring  # inspeciona o motor de score caso a caso
```

---

## Rotas

| Rota | O que é |
|---|---|
| `/inteligencia-comercial` | **Central de Inteligência Comercial** — página interna do menu personalizado |
| `/inteligencia-comercial/widget` | **Widget contextual** — popup aberto do atendimento ou do CRM |
| `/inteligencia-comercial/configuracoes` | Modos de automação, taxonomia de etiquetas, diagnóstico da integração |
| `/api/health` | Diagnóstico: o que está configurado e quais contratos seguem pendentes |

### Parâmetros

**Central** (obrigatórios): `accountId` (ou `tenantId`), `userId`
Opcionais: `preset` (`7d`/`15d`/`30d`/`90d`), `teamId`, `agentId`, `priority`

**Widget** (obrigatórios): `accountId`, `userId`
Opcionais: `contactId`, `sessionId`, `cardId`, `origin` (`atendimento` | `crm`)

O widget prioriza o caso de onde foi aberto: `sessionId` → `cardId` → `contactId`.

> **O perfil do usuário NUNCA vem da URL.** Ele é resolvido no servidor contra o
> cadastro da conta. Trocar o `userId` na barra de endereços não concede acesso.

---

## Variáveis de ambiente

Copie `.env.example` para **`.env.local`** e preencha. **Nenhuma leva o prefixo
`NEXT_PUBLIC_`** — todas são lidas apenas no servidor.

| Variável | Para que serve | Obrigatória? |
|---|---|---|
| `FLW_API_TOKEN` | Token permanente. Gerado em *Configurações > Integrações > Integração API* | Para dados reais |
| `FLW_CORE_API_URL` | URL base do grupo `core` (contatos, etiquetas, painéis, cards, usuários) | Para dados reais |
| `FLW_CHAT_API_URL` | URL base do grupo `chat` (conversas, mensagens, notas) | Para dados reais |
| `FLW_AUTH_API_URL` | URL base do login integrado. Sem ela, recai sobre `core` | Não |
| `AI_PROVIDER_API_KEY` | Provedor de IA. **Ainda não usado** — o motor atual é determinístico | Não |
| `APP_BASE_URL` | URL pública deste módulo. Usada para montar o endereço do webhook | Sim |
| `FLW_EMBED_ORIGINS` | Origens da KlipFlowi autorizadas a exibir este módulo em iframe | Para incorporar |
| `FLW_WEBHOOK_SECRET` | Segredo HMAC dos webhooks. **Sem ele, nenhum evento é aceito** | Para webhooks |
| `FLW_DATA_MODE` | `mock` (padrão) ou `live` | Não |

> Não presuma um domínio único: leia o campo `servers` do OpenAPI de **cada grupo**
> de endpoints e preencha `FLW_CORE_API_URL` e `FLW_CHAT_API_URL` separadamente.

---

## O que precisa ser confirmado na documentação

Os caminhos vieram do índice oficial (`https://flwchat.readme.io/llms.txt`). O que
falta está declarado explicitamente em `src/server/integration/endpoints.ts` e
listado em tempo real por **`GET /api/health`** e pela tela de configurações.

**Confirmado** (17 endpoints): conversas (`/v2/session`), mensagens
(`/v1/session/{id}/message`), notas internas, envio de mensagem.
O prefixo `chat` é certo porque a documentação cita `/chat/v1/message/{id}/status`.

**Pendente** (42 endpoints), em três grupos:

1. **Prefixo de serviço `core` vs `chat`** — inferido para contatos, etiquetas,
   painéis, cards, usuários e webhooks. Só `core/v2/file` e `chat/v1/message` são
   citados textualmente na documentação. *Abra a página de cada endpoint (acrescente
   `.md` à URL) e confirme.*

2. **Contratos críticos de escrita** — bloqueiam a execução real:
   - `PUT /v3/panel/card/{id}` — nomes dos campos do corpo, e como `WON`/`LOST` e o
     motivo de perda são enviados. Libere com `FLW_CARD_WRITE_CONFIRMED=true`.
   - `POST /v1/contact/{id}/tags` — **substitui a lista inteira ou adiciona?**
     Errar aqui apagaria etiquetas aplicadas manualmente pela equipe. Libere com
     `FLW_CONTACT_TAGS_SEMANTICS=replace` ou `=append`.

3. **Não constam do índice**:
   - **Login integrado** — método, caminho e formato do token
     (`https://flwchat.readme.io/reference/login-integrado.md`)
   - **Assinatura de webhook** — nome do header e algoritmo
     (`https://flwchat.readme.io/reference/webhooks-1.md`)
   - **Paginação** — nomes dos parâmetros (`paginação.md`)
   - **Rate limit** da conta (`rate-limiting.md`)

Cada caminho aceita override por ambiente: `FLW_EP_<CHAVE>=/caminho/real`.

---

## Como testar

### 1. Central de Inteligência Comercial

```
http://localhost:3000/inteligencia-comercial?accountId=acc_klipflowi_demo&userId=user_carla
```

Deve mostrar 4 oportunidades, 10 indicadores e 6 abas.

### 2. Permissões (troque só o `userId`)

| `userId` | Perfil | Deve ver |
|---|---|---|
| `user_ana` | Vendedor | **3** — só os próprios atendimentos |
| `user_carla` | Gestor | **4** — a equipe Comercial Interno |
| `user_elaine` | Admin | **5** — a conta toda |

### 3. Motor de score

```bash
npm run verify:scoring
```

Casos propositais no dataset:

| Conversa | Esperado |
|---|---|
| `sess_001` Marcelo | **76 pts, crítica** — orçamento aprovado + prazo + sem retorno |
| `sess_002` Rogério | **72 pts** — proposta enviada, cliente parou de responder |
| `sess_005` Fernando | **Não aparece** — suporte técnico puro |
| `sess_006` Thiago | **Não aparece** — só "quanto custa?", palavra isolada sem contexto |
| `sess_007` Juliana | **Não aparece** — compra já concluída |

### 4. Fluxo de confirmação

Clique **"Criar oportunidade"** em qualquer card. O modal mostra o diff
(antes → depois), as evidências com trechos literais da conversa e a confiança.
Ao confirmar, o aviso deixa claro que **nada foi alterado na KlipFlowi**.

### 5. Modos de automação

Em `/inteligencia-comercial/configuracoes` (como `user_elaine`):

- **Observador** → as ações passam a ser recusadas com `403`
- **Automático controlado** → tente autorizar "Enviar mensagem": o servidor
  **filtra e remove** da lista. Essa trava não é configurável.

### 6. Webhook

```bash
SECRET="seu_segredo"   # o mesmo de FLW_WEBHOOK_SECRET
BODY='{"event":"MESSAGE_RECEIVED","accountId":"acc_klipflowi_demo","sessionId":"sess_001","id":"evt_1"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -X POST http://localhost:3000/api/webhooks/klipflowi \
  -H 'Content-Type: application/json' \
  -H "x-klipflowi-signature: sha256=$SIG" -d "$BODY"
```

Esperado: `202 enfileirado`. Repetir → `duplicado`. Alterar o corpo → `401`.

---

## Arquitetura

```
Navegador  ──►  /api/*  ──►  services  ──►  adapters  ──►  API KlipFlowi
(sem token)   (servidor)        │         (9 adapters)
                                ▼
                      scoring · automação · auditoria
```

```
src/
├── domain/                    Tipos e enumerações
├── mocks/dataset.ts           Dataset simulado
├── lib/                       Formatação e cliente HTTP do frontend
├── components/
│   ├── ui/primitives.tsx      Kit reutilizável
│   └── intelligence/          Componentes do produto
├── app/
│   ├── inteligencia-comercial/   Central, widget e configurações
│   └── api/                      Rotas de servidor
└── server/                    ← só aqui o token existe
    ├── config/env.ts          Leitura de ambiente (`server-only`)
    ├── security/              Máscaras, contexto de tenant, permissões
    ├── scoring/               Detecção de sinais e cálculo do score
    ├── integration/
    │   ├── endpoints.ts       Registry com estado de validação
    │   ├── http/              Cliente, rate limit, cache
    │   ├── mappers/           Leitores tolerantes de payload
    │   └── adapters/          Auth · Sessions · Messages · Contacts ·
    │                          Tags · Panels · Cards · Agents · Webhooks
    └── services/              Oportunidades, automação, etiquetas,
                               auditoria, chat, qualidade, fila
db/migrations/0001_init.sql    14 tabelas com RLS por conta
```

### Score (0–100)

| Dimensão | Máx |
|---|---|
| Intenção explícita de compra | 30 |
| Recência da interação | 15 |
| Clareza da necessidade | 15 |
| Maturidade comercial | 15 |
| Existência de próximo passo | 10 |
| Relacionamento / recorrência | 10 |
| Qualidade dos dados | 5 |

**Score ≠ confiança.** O score mede o quanto vale priorizar; a **confiança** mede
quanta evidência sustenta a leitura. Um caso pode ter score alto e confiança baixa.

Faixas: **75+** alta · **50–74** média · **30–49** em desenvolvimento · **<30** não exibida.

O score é reduzido quando só há sinais fracos e isolados, e zerado por
desqualificadores (descadastro, spam, compra concluída). *"Quanto custa?" sozinho
não faz de ninguém uma oportunidade.*

### Modos de automação

| Modo | Comportamento |
|---|---|
| **Observador** | Só analisa e recomenda. Não altera nada |
| **Copiloto** *(padrão)* | Prepara a mudança; uma pessoa confirma |
| **Automático controlado** | Executa sozinho apenas ações de baixo risco autorizadas |

**Sempre exigem confirmação humana, em qualquer modo** — e nenhuma configuração
consegue liberar: enviar mensagem, marcar ganha/perdida, alterar valor, trocar
responsável, excluir dados, arquivar.

---

## Segurança e LGPD

- O token vive só no servidor. `src/server/config/env.ts` importa `server-only`:
  qualquer tentativa de usá-lo no cliente quebra o build.
- **Isolamento por conta** em toda consulta, mais RLS no banco.
- **Proteção contra IDOR**: formato validado, usuário resolvido contra a conta,
  perfil vindo do cadastro. Perfil desconhecido cai em `VENDEDOR` — o mais restrito.
- **Mascaramento**: telefone, e-mail e documento nunca saem completos nem entram em log.
- **Webhook falha fechado**: sem segredo, nenhum evento é aceito. Assinatura
  comparada em tempo constante.
- **Idempotência** obrigatória em toda escrita.
- Uso das conversas para treinamento: **desligado por padrão**.
- Retenção configurável (30–1095 dias).
- `audit_logs` não aceita `UPDATE` nem `DELETE`.

---

## O que ainda é simulado

Tudo que aparece na interface. Especificamente:

- Conversas, contatos, painéis, cards, etiquetas e usuários → `src/mocks/dataset.ts`
- Auditoria, configurações e fila → memória do processo (reiniciam com o servidor)
- Chat → motor determinístico de intenção, **sem LLM**. A vantagem: ele só consegue
  citar o que está no contexto carregado, então não tem como alucinar.

Ao configurar as variáveis e definir `FLW_DATA_MODE=live`, as **leituras** passam a
usar a API. As **escritas** continuam bloqueadas até a validação dos contratos.

---

## Próximos passos

1. Confirmar os prefixos `core`/`chat` e os contratos de escrita
2. Implementar o login integrado (`authAdapter`)
3. Confirmar a assinatura dos webhooks
4. Trocar os repositórios em memória pelo Postgres de `db/migrations/`
5. Conectar o provedor de IA ao chat, mantendo as citações obrigatórias
6. Testar contra a API real em conta de homologação
