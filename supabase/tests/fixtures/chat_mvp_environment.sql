-- ISOLATED DATABASE ONLY, after group_mvp_schema.sql. Never run against Supabase.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to authenticated;
create publication supabase_realtime;
-- Reproduce the broad defaults observed in the project's live schema.
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
alter default privileges grant all on functions to anon,authenticated,service_role;
