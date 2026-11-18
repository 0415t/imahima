-- READ ONLY. No generator/RPC invocation and no synthetic user or data writes.
begin read only;
with tables(name) as (values ('profiles'),('rooms'),('room_members'),('group_mvp_rate_limits'),('messages'),('room_message_events')),
roles(name) as (values ('anon'),('authenticated'),('service_role')),
privileges(name) as (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')),
rpcs(signature) as (values
 ('public.group_mvp_execute(text,uuid,jsonb)'),('public.group_mvp_consume_rate(text,integer)'),
 ('public.chat_send_message(uuid,uuid,text,uuid)'),('public.chat_delete_message(uuid,uuid,uuid)'),
 ('public.chat_list_messages(uuid,uuid,integer,jsonb)'),('public.chat_list_message_events(uuid,uuid,text,integer,jsonb)'))
select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl) order by c.relname)
   from pg_class c join tables t on c.relname=t.name where c.relnamespace='public'::regnamespace),
 'table_privileges',(select jsonb_agg(jsonb_build_object('role',r.name,'table',t.name,'privilege',p.name,'allowed',has_table_privilege(r.name,'public.'||t.name,p.name)) order by r.name,t.name,p.name) from roles r cross join tables t cross join privileges p),
 'column_privileges',(select jsonb_agg(jsonb_build_object('role',r.name,'table',t.name,'privilege',p.name,'allowed',has_any_column_privilege(r.name,'public.'||t.name,p.name)) order by r.name,t.name,p.name)
   from roles r cross join tables t cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(name)),
 'message_column_updates',(select jsonb_agg(jsonb_build_object('column',a.attname,'service_update',has_column_privilege('service_role',a.attrelid,a.attname,'UPDATE')) order by a.attnum) from pg_attribute a where a.attrelid='public.messages'::regclass and a.attnum>0 and not a.attisdropped),
 'rpc_privileges',(select jsonb_agg(jsonb_build_object('role',r.name,'function',f.signature,'execute',has_function_privilege(r.name,f.signature,'EXECUTE')) order by r.name,f.signature) from roles r cross join rpcs f),
 'rpc_security',(select jsonb_agg(jsonb_build_object('function',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl) order by p.oid::regprocedure::text) from pg_proc p join rpcs f on p.oid=f.signature::regprocedure),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where p.schemaname='public' and p.tablename in (select name from tables)),
 'membership_helper',(select jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE')) from pg_proc p where p.oid='chat_private.can_read_room(uuid)'::regprocedure),
 'registration_helper',(select jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE')) from pg_proc p where p.oid='chat_local_support.handle_new_user()'::regprocedure),
 'private_schemas',(select jsonb_agg(jsonb_build_object('role',r.name,'schema',s.name,'usage',has_schema_privilege(r.name,s.name,'USAGE'),'create',has_schema_privilege(r.name,s.name,'CREATE')) order by r.name,s.name) from roles r cross join (values ('chat_private'),('chat_local_support')) s(name)),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated) order by c.conrelid,c.conname) from pg_constraint c where c.conrelid in (select ('public.'||name)::regclass from tables)),
 'indexes',(select jsonb_agg(to_jsonb(i) order by i.tablename,i.indexname) from pg_indexes i where i.schemaname='public' and i.tablename in (select name from tables)),
 'triggers',(select jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by t.tgname) from pg_trigger t where not t.tgisinternal and (t.tgrelid in ('public.messages'::regclass,'public.room_message_events'::regclass) or (t.tgrelid='auth.users'::regclass and t.tgname='chat_local_profile_created'))),
 'publications',(select jsonb_agg(jsonb_build_object('name',pubname,'all_tables',puballtables,'insert',pubinsert) order by pubname) from pg_publication),
 'publication_schemas',(select coalesce(jsonb_agg(jsonb_build_object('publication',p.pubname,'schema',n.pnnspid::regnamespace::text)),'[]') from pg_publication_namespace n join pg_publication p on p.oid=n.pnpubid),
 'published_tables',(select coalesce(jsonb_agg(to_jsonb(p) order by p.pubname,p.schemaname,p.tablename),'[]') from pg_publication_tables p),
 'event_columns',(select jsonb_agg(column_name order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='room_message_events'),
 'rows',jsonb_build_object('auth_users',(select count(*) from auth.users),'profiles',(select count(*) from public.profiles),'rooms',(select count(*) from public.rooms),'room_members',(select count(*) from public.room_members),'rate_limits',(select count(*) from public.group_mvp_rate_limits),'messages',(select count(*) from public.messages),'events',(select count(*) from public.room_message_events))
) as report;
commit;
