-- Views de leitura do Módulo 01.

-- Lista de atendimentos já com nome/telefone do contato.
create or replace view klip.v_atendimentos
with (security_invoker = true) as
select s.id,
       s.contact_id,
       c.name  as contact_name,
       c.phone as contact_phone,
       s.agent_id,
       coalesce(s.agent_name, a.name) as agent_name,
       s.status,
       s.channel,
       s.created_at,
       s.last_interaction_at,
       s.preview_url,
       s.message_count,
       s.audio_count,
       s.pending_transcriptions,
       s.needs_message_sync,
       s.messages_synced_at,
       s.message_sync_error
from klip.sessions s
left join klip.contacts c on c.id = s.contact_id
left join klip.agents a on a.id = s.agent_id;

-- Contatos citados em conversas que ainda não foram buscados.
create or replace view klip.v_contatos_faltando
with (security_invoker = true) as
select distinct s.contact_id as id
from klip.sessions s
left join klip.contacts c on c.id = s.contact_id
where s.contact_id is not null and c.id is null;

revoke all on klip.v_atendimentos, klip.v_contatos_faltando from public, anon, authenticated;
grant select on klip.v_atendimentos, klip.v_contatos_faltando to service_role;
