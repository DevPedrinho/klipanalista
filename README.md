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
| ✅ Interface, motor de score, auditoria, modos de automação | **Funcionando, com 171 testes automatizados** |
| ✅ Autenticação da API (`Authorization: Bearer pn_...`) | **Confirmada na documentação oficial** |
| ✅ Caminhos dos endpoints de leitura | **Extraídos do índice oficial da documentação** |
| 🟡 Dados exibidos | **Simulados.** Nenhuma chamada real à API foi feita ou testada |
| ✅ Aplicar etiquetas no contato | **Liberado** — contrato confirmado, operação aditiva |
| 🔴 Escrita de card no CRM (criar/atualizar) | **Bloqueada de propósito** — campos do corpo não validados |
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
npm test                # 171 testes automatizados (~1s)
npm run verify          # typecheck + lint + testes + build — rode antes de publicar
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

**URL base confirmada:** a página "Atualizar etiquetas" mostra o endereço
completo — `https://api.wts.chat/core/v1/contact/{id}/tags`. O host é
`api.wts.chat` e o caminho segue `/{grupo}/{versão}/{recurso}`.

**Três grupos, não dois.** O menu da documentação separa:

| Grupo | Recursos |
|---|---|
| `core` | contatos, etiquetas, equipes, usuários, webhooks, arquivos, campos |
| `chat` | conversas, mensagens, notas internas, canais, chatbots, envios |
| `crm` | **painéis e cards** |

> Painéis e cards estavam classificados como `core` por inferência minha. Estão
> em `crm`. Isso teria produzido 404 em produção.

**Confirmado** (22 endpoints): conversas, mensagens, notas internas, envio de
mensagem, e todo o grupo de contatos — incluindo etiquetas.

**Pendente** (42 endpoints), em três grupos:

1. **Prefixo de serviço `core` vs `chat`** — inferido para contatos, etiquetas,
   painéis, cards, usuários e webhooks. Só `core/v2/file` e `chat/v1/message` são
   citados textualmente na documentação. *Abra a página de cada endpoint (acrescente
   `.md` à URL) e confirme.*

2. **Contratos críticos de escrita:**
   - ~~`PUT /v3/panel/card/{id}`~~ — **contrato confirmado.** O corpo declara em
     `fields` quais campos mudam; `status` aceita `OPEN`/`WON`/`LOST`/`ARCHIVED`
     e o motivo de perda vai em `lostReasonId`. Resta apenas confirmar os 14
     valores do enum `fields`, ocultos na documentação pública.
   - ~~`POST /v1/contact/{id}/tags`~~ — **resolvido.** A API tem um campo
     `operation` explícito: `InsertIfNotExists`, `DeleteIfExists` ou
     `ReplaceAll`. O módulo usa exclusivamente **`InsertIfNotExists`**, que
     apenas acrescenta. `ReplaceAll` apagaria as etiquetas manuais da equipe, e
     dois testes automatizados impedem essa troca.

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

## Banco de dados

Duas migrações, aplicadas nesta ordem:

| Arquivo | O que faz |
|---|---|
| `db/migrations/0001_init.sql` | 14 tabelas, 40 índices, 6 tipos enum, RLS por conta e auditoria imutável. Portável para qualquer PostgreSQL 13+ |
| `db/migrations/0002_supabase.sql` | Específico do Supabase: fecha a API REST automática e cria o papel de aplicação que respeita RLS |

### Por que o 0002 existe

O Supabase tem duas características que, ignoradas, deixam o banco aberto:

1. **Publica as tabelas do schema `public` como API REST**, acessível pelo
   navegador com a chave anônima. Este módulo não é acessado pelo navegador —
   quem fala com o banco é o backend. O `0002` revoga `anon` e `authenticated`.
2. **A string de conexão padrão usa o papel `postgres`, que é superusuário** —
   e superusuário **ignora Row Level Security**. Conectar assim tornaria as 13
   políticas decorativas. O `0002` cria `flowi_app`, sem `SUPERUSER` e sem
   `BYPASSRLS`.

> **Conecte a aplicação como `flowi_app`, nunca como `postgres`.** O passo final
> (definir a senha e montar a `DATABASE_URL`) está comentado no fim do `0002`,
> fora do versionamento.

### Comportamento verificado

Ambas foram aplicadas do zero em um PostgreSQL 16 local, com os papéis do
Supabase simulados:

| Verificação | Resultado |
|---|---|
| `anon` lê a auditoria | negado |
| `authenticated` lê as conversas | negado |
| `flowi_app` sem conta definida | 0 linhas — falha fechado |
| `flowi_app` com uma conta | apenas os registros daquela conta |
| Gravar registro de outra conta | recusado pela RLS |
| `flowi_app` alterar a auditoria | sem privilégio |
| Superusuário adulterar a auditoria | erro, conteúdo preservado |
| Reaplicar o `0002` | idempotente |

### Testar localmente

```bash
createdb flowi_local
psql -d flowi_local -f db/migrations/0001_init.sql
psql -d flowi_local -f db/migrations/0002_supabase.sql
```

---

## Testes automatizados

```bash
npm test
```

171 testes em 5 suítes, focados no que causa dano real se quebrar:

| Suíte | O que protege |
|---|---|
| `tests/scoring.test.ts` | Palavra isolada não vira oportunidade · desqualificadores zeram o score · score ≠ confiança · tetos das 7 dimensões |
| `tests/automation.test.ts` | **Cada ação sensível × cada modo**: nenhuma combinação executa sozinha · configuração não afrouxa a trava · isolamento por conta |
| `tests/security.test.ts` | IDOR · escopo por perfil · parâmetros maliciosos na URL · mascaramento de telefone, e-mail, documento e token |
| `tests/tags-endpoints.test.ts` | Etiqueta duplicada nunca é criada · criação exige aprovação · contrato pendente não pode ser chamado |
| `tests/pipeline.test.ts` | Oportunidade ponta a ponta · auditoria mascarada · debounce da fila · chat admite quando não sabe |

### Estes testes têm dentes

Foram validados por sabotagem deliberada — quebrei cada trava e confirmei que a
suíte acusa:

| Sabotagem | Resultado |
|---|---|
| Remover "enviar mensagem" da lista de confirmação obrigatória | 1 teste falha |
| Fazer o vendedor enxergar a equipe inteira | 3 testes falham |
| Baixar o corte de score de 30 para 5 | 3 testes falham |

### Um bug real que os testes encontraram

O sinal `ORCAMENTO_APROVADO` — o de maior peso no motor — **não disparava** na
forma mais natural em português: *"o orçamento **já** foi aprovado"*. O padrão
exigia "orçamento foi aprovado" literal, sem advérbio no meio.

Estava silenciosamente quebrado até no próprio dataset de exemplo. Após a
correção, `sess_001` subiu de **76 para 81 pontos**.

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
db/migrations/                 0001 esquema · 0002 ajustes do Supabase
tests/                         171 testes automatizados
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
   (o banco já está pronto e testado — falta a camada de acesso no código)
5. Conectar o provedor de IA ao chat, mantendo as citações obrigatórias
6. Testar contra a API real em conta de homologação
7. Rodar `npm run verify` em CI a cada pull request
