-- ===========================================================================
-- Flowi Copilot Comercial — ajustes específicos do Supabase
-- Aplicar DEPOIS de 0001_init.sql
-- ===========================================================================
-- O 0001 é portável para qualquer PostgreSQL. Este arquivo trata de duas
-- características do Supabase que, se ignoradas, deixam o banco exposto:
--
--   1. O Supabase publica automaticamente as tabelas do schema `public` como
--      API REST, acessível pelo navegador com a chave anônima.
--   2. A string de conexão padrão usa o papel `postgres`, que é superusuário
--      e portanto IGNORA as políticas de Row Level Security.
--
-- Este módulo não é acessado pelo navegador: quem fala com o banco é o backend
-- do próprio módulo. Então fechamos a porta da API REST e criamos um papel de
-- aplicação sem privilégio de contornar RLS.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Fechar a API REST automática
-- ---------------------------------------------------------------------------
-- `anon` é o papel de quem chega com a chave pública, direto do navegador.
-- `authenticated` é o usuário logado pelo Supabase Auth — que este módulo não
-- usa. Nenhum dos dois deve enxergar estas tabelas.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    REVOKE USAGE ON SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    REVOKE USAGE ON SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Papel de aplicação — é com ele que o módulo deve conectar
-- ---------------------------------------------------------------------------
-- Sem BYPASSRLS e sem SUPERUSER: as políticas do 0001 passam a valer de fato.
-- O papel nasce sem LOGIN; a senha é definida no passo 3, fora do versionamento.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowi_app') THEN
    CREATE ROLE flowi_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO flowi_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowi_app;

-- Tabelas criadas por migrações futuras já nascem acessíveis ao papel.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO flowi_app;

-- A auditoria é imutável mesmo para o papel da aplicação: os gatilhos de
-- 0001_init.sql recusam UPDATE e DELETE. Retiramos também o privilégio, para
-- que a recusa venha antes mesmo do gatilho.
REVOKE UPDATE, DELETE ON audit_logs FROM flowi_app;

COMMIT;

-- ===========================================================================
-- 3. PASSO MANUAL — definir a senha e montar a string de conexão
-- ===========================================================================
-- A senha NÃO entra neste arquivo, que vai para o repositório. Rode no SQL
-- Editor do Supabase, trocando o valor por uma senha forte e única:
--
--   ALTER ROLE flowi_app LOGIN PASSWORD 'SUA_SENHA_FORTE_AQUI';
--
-- Depois monte a variável de ambiente do módulo com esse papel — e não com o
-- usuário `postgres` da string de conexão que o Supabase mostra por padrão:
--
--   DATABASE_URL=postgresql://flowi_app:SUA_SENHA@<host>:5432/postgres
--
-- O host aparece em Project Settings > Database > Connection string.
-- Para ambientes sem IPv6, use a porta 6543 (pooler) no lugar da 5432.
--
-- ===========================================================================
-- COMO CONFERIR QUE FICOU CERTO
-- ===========================================================================
-- Conectado como flowi_app, isto deve devolver 0 linhas (nenhuma conta ativa):
--
--   SELECT count(*) FROM audit_logs;
--
-- E isto deve devolver apenas os registros da conta escolhida:
--
--   SET app.current_account_id = 'acc_exemplo';
--   SELECT count(*) FROM audit_logs;
--
-- Se o primeiro comando já devolver linhas, a conexão está usando um papel
-- superusuário e a isolação entre contas NÃO está valendo.
-- ===========================================================================
