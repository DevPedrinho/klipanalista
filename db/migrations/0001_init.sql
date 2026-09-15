-- ===========================================================================
-- Flowi Copilot Comercial — esquema inicial
-- PostgreSQL 14+
-- ===========================================================================
-- ISOLAMENTO ENTRE CONTAS:
-- Toda tabela carrega `account_id` e possui política de Row Level Security.
-- Nenhuma consulta da aplicação deve omitir o filtro de conta: a RLS é a
-- segunda barreira, não a única.
--
-- ESTADO NESTA ENTREGA:
-- A aplicação ainda opera com repositórios em memória. Este arquivo define o
-- destino da persistência e mantém a modelagem revisável desde já. Os
-- serviços foram escritos contra interfaces equivalentes a estas tabelas,
-- então a troca não altera os chamadores.
-- ===========================================================================

BEGIN;

-- `gen_random_uuid()` faz parte do núcleo do PostgreSQL desde a versão 13,
-- portanto nenhuma extensão é necessária. No Supabase isso importa: as
-- extensões vivem no schema `extensions`, e um `CREATE EXTENSION` solto pode
-- cair no schema errado.

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
CREATE TYPE automation_mode AS ENUM (
  'OBSERVADOR', 'COPILOTO', 'AUTOMATICO_CONTROLADO'
);

CREATE TYPE opportunity_priority AS ENUM (
  'CRITICA', 'ALTA', 'MEDIA', 'BAIXA'
);

CREATE TYPE opportunity_state AS ENUM (
  'NOVA', 'ANALISADA', 'EM_ANDAMENTO', 'CONVERTIDA', 'IGNORADA'
);

CREATE TYPE action_status AS ENUM (
  'SUGERIDA', 'AGUARDANDO_APROVACAO', 'APROVADA',
  'EXECUTADA', 'FALHOU', 'REJEITADA', 'BLOQUEADA_POR_MODO'
);

CREATE TYPE user_role AS ENUM ('VENDEDOR', 'GESTOR', 'ADMIN');

CREATE TYPE webhook_status AS ENUM (
  'RECEBIDO', 'ENFILEIRADO', 'PROCESSADO', 'IGNORADO', 'FALHOU'
);

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identificador da conta na KlipFlowi. É a chave de isolamento.
  account_id      TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users — espelho local dos usuários da conta
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  platform_user_id  TEXT NOT NULL,
  name              TEXT NOT NULL,
  -- E-mail guardado cifrado: ver nota de criptografia no fim do arquivo.
  email_encrypted   BYTEA,
  role              user_role NOT NULL DEFAULT 'VENDEDOR',
  team_id           TEXT,
  team_name         TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, platform_user_id)
);

CREATE INDEX idx_users_account_team ON users (account_id, team_id);

-- ---------------------------------------------------------------------------
-- integration_settings — uma linha por conta
-- ---------------------------------------------------------------------------
CREATE TABLE integration_settings (
  account_id              TEXT PRIMARY KEY REFERENCES tenants(account_id) ON DELETE CASCADE,
  automation_mode         automation_mode NOT NULL DEFAULT 'COPILOTO',
  -- Ações de baixo risco liberadas no modo automático controlado.
  allowed_auto_actions    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  data_retention_days     INTEGER NOT NULL DEFAULT 180
                            CHECK (data_retention_days BETWEEN 30 AND 1095),
  allow_training_usage    BOOLEAN NOT NULL DEFAULT FALSE,
  default_panel_id        TEXT,
  triage_step_id          TEXT,
  -- Credenciais cifradas na aplicação antes de chegar aqui. Nunca em texto puro.
  api_token_encrypted     BYTEA,
  webhook_secret_encrypted BYTEA,
  updated_by_user_id      TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- conversation_snapshots — cópia analisada de um atendimento
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  contact_id          TEXT,
  channel             TEXT,
  agent_id            TEXT,
  status              TEXT,
  started_at          TIMESTAMPTZ,
  last_message_at     TIMESTAMPTZ,
  message_count       INTEGER NOT NULL DEFAULT 0,
  -- Hash do conteúdo: permite detectar se houve informação nova sem reler tudo.
  content_hash        TEXT,
  -- Mensagens com dados sensíveis já mascarados.
  messages_masked     JSONB NOT NULL DEFAULT '[]'::JSONB,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, session_id)
);

CREATE INDEX idx_conv_account_last_msg
  ON conversation_snapshots (account_id, last_message_at DESC);
CREATE INDEX idx_conv_account_agent
  ON conversation_snapshots (account_id, agent_id);

-- ---------------------------------------------------------------------------
-- crm_snapshots — cópia dos cards do CRM
-- ---------------------------------------------------------------------------
CREATE TABLE crm_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  card_id         TEXT NOT NULL,
  panel_id        TEXT NOT NULL,
  panel_type      TEXT,
  step_id         TEXT,
  step_name       TEXT,
  title           TEXT,
  contact_id      TEXT,
  session_id      TEXT,
  responsible_id  TEXT,
  amount          NUMERIC(14, 2),
  status          TEXT,
  due_date        TIMESTAMPTZ,
  card_updated_at TIMESTAMPTZ,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, card_id)
);

CREATE INDEX idx_crm_account_panel ON crm_snapshots (account_id, panel_id, step_id);
CREATE INDEX idx_crm_account_contact ON crm_snapshots (account_id, contact_id);

-- ---------------------------------------------------------------------------
-- ai_analysis — cada execução da análise sobre uma conversa
-- ---------------------------------------------------------------------------
CREATE TABLE ai_analysis (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  contact_id          TEXT,
  score               SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  -- Confiança é independente do score: mede a evidência disponível.
  confidence          SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  priority            opportunity_priority NOT NULL,
  -- Composição das 7 dimensões do score.
  score_breakdown     JSONB NOT NULL,
  rationale           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Versão do motor de score, para comparar análises ao longo do tempo.
  engine_version      TEXT NOT NULL DEFAULT 'v1',
  analyzed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_analysis_account_session
  ON ai_analysis (account_id, session_id, analyzed_at DESC);

-- ---------------------------------------------------------------------------
-- opportunities
-- ---------------------------------------------------------------------------
CREATE TABLE opportunities (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  session_id              TEXT NOT NULL,
  contact_id              TEXT NOT NULL,
  card_id                 TEXT,
  analysis_id             UUID REFERENCES ai_analysis(id) ON DELETE SET NULL,

  contact_name            TEXT NOT NULL,
  company                 TEXT,
  channel                 TEXT,
  agent_id                TEXT,

  product_interest        TEXT,
  need_summary            TEXT,

  score                   SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence              SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  priority                opportunity_priority NOT NULL,
  state                   opportunity_state NOT NULL DEFAULT 'NOVA',

  estimated_value         NUMERIC(14, 2),
  -- Marca valores que a IA inferiu e que nenhuma pessoa confirmou.
  estimated_value_inferred BOOLEAN NOT NULL DEFAULT FALSE,

  last_interaction_at     TIMESTAMPTZ,
  hours_without_reply     INTEGER,

  next_action             TEXT,
  suggested_message       TEXT,
  recommended_tag_keys    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  recommended_step_name   TEXT,
  objections              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uma oportunidade aberta por atendimento: evita duplicidade.
  UNIQUE (account_id, session_id)
);

CREATE INDEX idx_opp_account_score ON opportunities (account_id, score DESC);
CREATE INDEX idx_opp_account_agent ON opportunities (account_id, agent_id);
CREATE INDEX idx_opp_account_state ON opportunities (account_id, state);
CREATE INDEX idx_opp_account_contact ON opportunities (account_id, contact_id);

-- ---------------------------------------------------------------------------
-- opportunity_evidence — trechos que sustentam cada conclusão
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_evidence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  opportunity_id  UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  signal_code     TEXT NOT NULL,
  label           TEXT NOT NULL,
  polarity        TEXT NOT NULL CHECK (polarity IN ('POSITIVE', 'NEGATIVE')),
  excerpt         TEXT NOT NULL,
  message_id      TEXT,
  sent_at         TIMESTAMPTZ,
  strength        NUMERIC(4, 3) NOT NULL CHECK (strength BETWEEN 0 AND 1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_opportunity ON opportunity_evidence (opportunity_id);

-- ---------------------------------------------------------------------------
-- opportunity_actions — ciclo de vida de cada ação sugerida
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_actions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  opportunity_id      UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  action_type         TEXT NOT NULL,
  status              action_status NOT NULL DEFAULT 'SUGERIDA',
  requires_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  payload_preview     JSONB,
  -- Chave de idempotência: impede que um retry duplique a escrita.
  idempotency_key     TEXT,
  requested_by        TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  executed_at         TIMESTAMPTZ,
  api_status_code     INTEGER,
  api_message         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX idx_actions_opportunity ON opportunity_actions (opportunity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- opportunity_feedback — aprendizado a partir do que a equipe aceita
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  opportunity_id  UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  useful          BOOLEAN NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, user_id)
);

-- ---------------------------------------------------------------------------
-- tag_taxonomy — catálogo curado, por conta
-- ---------------------------------------------------------------------------
CREATE TABLE tag_taxonomy (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  tag_key             TEXT NOT NULL,
  canonical_name      TEXT NOT NULL,
  description         TEXT,
  -- Regra que justifica a aplicação. Registrada na auditoria.
  rule                TEXT NOT NULL,
  color               TEXT,
  synonyms            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Id da etiqueta correspondente na plataforma, quando já existe.
  platform_tag_id     TEXT,
  -- Etiqueta nova só entra em uso após aprovação administrativa.
  approved            BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, tag_key)
);

-- ---------------------------------------------------------------------------
-- ai_chat_history
-- ---------------------------------------------------------------------------
CREATE TABLE ai_chat_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  conversation_key    TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content             TEXT NOT NULL,
  citations           JSONB NOT NULL DEFAULT '[]'::JSONB,
  insufficient_data   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_account_user
  ON ai_chat_history (account_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,
  event             TEXT NOT NULL,
  -- Deduplicação de entregas repetidas.
  idempotency_key   TEXT NOT NULL,
  session_id        TEXT,
  contact_id        TEXT,
  card_id           TEXT,
  status            webhook_status NOT NULL DEFAULT 'RECEBIDO',
  -- Payload com dados sensíveis já mascarados.
  payload_masked    JSONB NOT NULL,
  error             TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX idx_webhook_account_status
  ON webhook_events (account_id, status, received_at DESC);

-- ---------------------------------------------------------------------------
-- audit_logs — registro completo e imutável
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            TEXT NOT NULL REFERENCES tenants(account_id) ON DELETE CASCADE,

  requested_by_user_id  TEXT NOT NULL,
  requested_by_name     TEXT NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  action_type           TEXT NOT NULL,
  action_status         action_status NOT NULL,

  target_kind           TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  target_label          TEXT NOT NULL,

  suggestion            TEXT NOT NULL,
  evidence_codes        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Estados anterior e posterior, já mascarados.
  before_state          JSONB,
  after_state           JSONB,

  ai_confidence         SMALLINT CHECK (ai_confidence BETWEEN 0 AND 100),
  automation_mode       automation_mode NOT NULL,

  api_ok                BOOLEAN,
  api_status_code       INTEGER,
  api_message           TEXT,
  success               BOOLEAN NOT NULL,

  approved_by_user_id   TEXT,
  approved_by_name      TEXT,
  approved_at           TIMESTAMPTZ
);

CREATE INDEX idx_audit_account_time ON audit_logs (account_id, occurred_at DESC);
CREATE INDEX idx_audit_account_target ON audit_logs (account_id, target_id);
CREATE INDEX idx_audit_account_user ON audit_logs (account_id, requested_by_user_id);

-- ---------------------------------------------------------------------------
-- Imutabilidade da auditoria
-- ---------------------------------------------------------------------------
-- Auditoria é registro histórico: alterar ou apagar descaracteriza a trilha.
--
-- A tentativa levanta erro em vez de ser descartada em silêncio. Um `DO INSTEAD
-- NOTHING` devolveria "UPDATE 0" e quem tentou adulterar acharia que funcionou;
-- o erro torna a tentativa visível para a aplicação e para o log do banco.
CREATE OR REPLACE FUNCTION audit_logs_imutavel() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs e um registro historico imutavel: % nao e permitido.', TG_OP
    USING HINT = 'Registre um novo evento descrevendo a correcao, nunca altere o anterior.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_sem_update
  BEFORE UPDATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_imutavel();

CREATE TRIGGER audit_logs_sem_delete
  BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_imutavel();

-- ===========================================================================
-- Row Level Security
-- ---------------------------------------------------------------------------
-- A aplicação define `SET LOCAL app.current_account_id = '<accountId>'` no
-- início de cada transação. Sem isso, nenhuma linha é visível.
--
-- ATENÇÃO — ISTO SÓ PROTEGE SE A CONEXÃO NÃO FOR DE SUPERUSUÁRIO.
-- Superusuários (e papéis com BYPASSRLS) ignoram as políticas abaixo. No
-- Supabase, a string de conexão padrão usa o papel `postgres`, que é
-- superusuário: conectar assim torna estas políticas decorativas.
-- A aplicação deve conectar com o papel criado em 0002_supabase.sql.
-- ===========================================================================

CREATE OR REPLACE FUNCTION current_account_id() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_account_id', TRUE), '');
$$ LANGUAGE SQL STABLE;

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'users', 'integration_settings', 'conversation_snapshots', 'crm_snapshots',
    'ai_analysis', 'opportunities', 'opportunity_evidence', 'opportunity_actions',
    'opportunity_feedback', 'tag_taxonomy', 'ai_chat_history', 'webhook_events',
    'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
         USING (account_id = current_account_id())
         WITH CHECK (account_id = current_account_id());',
      t, t
    );
  END LOOP;
END $$;

COMMIT;

-- ===========================================================================
-- NOTAS DE OPERAÇÃO
-- ===========================================================================
-- 1. CRIPTOGRAFIA
--    Os campos *_encrypted guardam bytes já cifrados pela aplicação (envelope
--    encryption com chave gerenciada em KMS/Vault). O banco nunca recebe a
--    credencial em texto puro, e a chave não vive no banco.
--
-- 2. RETENÇÃO (LGPD)
--    `integration_settings.data_retention_days` define por quanto tempo os
--    dados analisados podem ser guardados. Uma rotina periódica deve apagar
--    conversation_snapshots, ai_analysis e ai_chat_history além desse prazo.
--    audit_logs tem retenção própria, normalmente mais longa, por ser trilha
--    de conformidade.
--
-- 3. MASCARAMENTO
--    Colunas JSONB de payload guardam dados já mascarados pela aplicação
--    (ver src/server/security/masking.ts). Telefone, e-mail e documento nunca
--    são persistidos em texto completo fora do sistema de origem.
-- ===========================================================================
