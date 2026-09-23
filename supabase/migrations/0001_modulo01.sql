-- Klip Analista · Módulo 01 — Listar Atendimentos
-- Tudo vive no schema `klip` (projeto Supabase dedicado ao Klip Analista).
-- Só o servidor (service_role) acessa; anon/authenticated não enxergam nada.

create schema if not exists klip;

revoke all on schema klip from public, anon, authenticated;
grant usage on schema klip to service_role;

-- Atendentes da conta ---------------------------------------------------------
create table klip.agents (
  id          text primary key,
  user_id     text,
  name        text,
  email       text,
  profile     text,
  departments jsonb not null default '[]',
  raw         jsonb not null,
  synced_at   timestamptz not null default now()
);

-- Contatos (buscados por id, só os que aparecem nas conversas) ------------------
create table klip.contacts (
  id        text primary key,
  name      text,
  phone     text,
  email     text,
  tags      jsonb not null default '[]',
  raw       jsonb not null,
  synced_at timestamptz not null default now()
);

-- Conversas ---------------------------------------------------------------------
create table klip.sessions (
  id                     text primary key,
  contact_id             text,
  agent_id               text,
  agent_name             text,
  status                 text,
  channel                text,
  created_at             timestamptz,
  started_at             timestamptz,
  last_interaction_at    timestamptz,
  last_message_in_at     timestamptz,
  last_message_out_at    timestamptz,
  first_response_at      timestamptz,
  time_wait              integer,
  time_service           integer,
  preview_url            text,
  raw                    jsonb not null,
  synced_at              timestamptz not null default now(),
  -- controle da sincronização de mensagens
  needs_message_sync     boolean not null default true,
  messages_synced_at     timestamptz,
  message_sync_error     text,
  message_count          integer not null default 0,
  audio_count            integer not null default 0,
  pending_transcriptions integer not null default 0
);

create index sessions_last_interaction_idx on klip.sessions (last_interaction_at desc);
create index sessions_needs_sync_idx on klip.sessions (needs_message_sync) where needs_message_sync;
create index sessions_agent_idx on klip.sessions (agent_id);
create index sessions_contact_idx on klip.sessions (contact_id);

-- Mensagens -----------------------------------------------------------------------
create table klip.messages (
  id                   text primary key,
  session_id           text not null references klip.sessions (id) on delete cascade,
  sent_at              timestamptz,
  direction            text not null check (direction in ('cliente', 'atendente')),
  author_user_id       text,
  type                 text,
  text                 text,
  transcription        text,
  transcription_status text check (transcription_status in ('ok', 'processando', 'erro', 'ausente')),
  media_url            text,
  raw                  jsonb not null
);

create index messages_session_idx on klip.messages (session_id, sent_at);

-- Rodadas de sincronização --------------------------------------------------------
create table klip.sync_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'rodando' check (status in ('rodando', 'concluida', 'erro')),
  phase        text not null default 'atendentes',
  cursor       jsonb not null default '{}',
  stats        jsonb not null default '{}',
  error        text,
  locked_until timestamptz not null default '-infinity',
  origem       text not null default 'manual'
);

create index sync_runs_started_idx on klip.sync_runs (started_at desc);

-- CRM: painéis (cache), cards e anotações criados pelo app -------------------------
create table klip.crm_panels (
  id        text primary key,
  title     text,
  type      text,
  steps     jsonb not null default '[]',
  raw       jsonb not null,
  synced_at timestamptz not null default now()
);

create table klip.crm_cards (
  id          text primary key,
  session_id  text references klip.sessions (id) on delete set null,
  contact_id  text,
  panel_id    text,
  step_id     text,
  title       text,
  created_at  timestamptz not null default now(),
  raw         jsonb not null
);

create index crm_cards_session_idx on klip.crm_cards (session_id);

create table klip.crm_card_notes (
  id         text primary key,
  card_id    text not null,
  session_id text references klip.sessions (id) on delete set null,
  text       text not null,
  created_at timestamptz not null default now(),
  raw        jsonb not null
);

create index crm_card_notes_card_idx on klip.crm_card_notes (card_id);

-- Espaço ocupado por tabela (tela de limpeza) --------------------------------------
create or replace function klip.uso_do_banco()
returns table (tabela text, linhas bigint, bytes bigint)
language sql
security definer
set search_path = ''
as $$
  select c.relname::text,
         c.reltuples::bigint,
         pg_total_relation_size(c.oid)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'klip' and c.relkind = 'r'
  order by 1;
$$;

-- Permissões ------------------------------------------------------------------------
alter table klip.agents          enable row level security;
alter table klip.contacts        enable row level security;
alter table klip.sessions        enable row level security;
alter table klip.messages        enable row level security;
alter table klip.sync_runs       enable row level security;
alter table klip.crm_panels      enable row level security;
alter table klip.crm_cards       enable row level security;
alter table klip.crm_card_notes  enable row level security;

grant all on all tables in schema klip to service_role;
grant all on all sequences in schema klip to service_role;
revoke all on function klip.uso_do_banco() from public, anon, authenticated;
grant execute on function klip.uso_do_banco() to service_role;
