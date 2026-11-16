-- ISOLATED DATABASE ONLY. Fixture + group migration + chat migration required.
-- All test writes, temporary helpers and injected failures roll back.
begin;
insert into auth.users(id) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5) n;
insert into public.profiles(id,username) select id,'Chat fixture' from auth.users
  where id::text like '00000000-0000-4000-8000-%';

create function pg_temp.service_call(statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  set local role service_role;
  execute statement into result;
  reset role; return result;
exception when others then reset role; raise;
end $$;
create function pg_temp.send(a uuid,r uuid,b text,c uuid default gen_random_uuid()) returns jsonb language sql as $$
 select pg_temp.service_call(format('select public.chat_send_message(%L::uuid,%L::uuid,%L::text,%L::uuid)',a,r,b,c));
$$;
create function pg_temp.remove(a uuid,r uuid,m uuid) returns jsonb language sql as $$
 select pg_temp.service_call(format('select public.chat_delete_message(%L::uuid,%L::uuid,%L::uuid)',a,r,m));
$$;
create function pg_temp.history(a uuid,r uuid,n integer default 50,c jsonb default null) returns jsonb language sql as $$
 select pg_temp.service_call(format('select public.chat_list_messages(%L::uuid,%L::uuid,%s,%L::jsonb)',a,r,n,c));
$$;
create function pg_temp.events(a uuid,r uuid,s text default '0',n integer default 50,c jsonb default null) returns jsonb language sql as $$
 select pg_temp.service_call(format('select public.chat_list_message_events(%L::uuid,%L::uuid,%L::text,%s,%L::jsonb)',a,r,s,n,c));
$$;
create temp table chat_test_context(a uuid,b uuid,c uuid,q uuid,d uuid,r1 uuid,r2 uuid,r3 uuid);
do $$
declare a uuid:='00000000-0000-4000-8000-000000000001'; b uuid:='00000000-0000-4000-8000-000000000002';
 c uuid:='00000000-0000-4000-8000-000000000003'; q uuid:='00000000-0000-4000-8000-000000000004';
 d uuid:='00000000-0000-4000-8000-000000000005'; r1 uuid; r2 uuid; r3 uuid;
 result jsonb; m uuid; client uuid:=gen_random_uuid(); cursor jsonb; page jsonb; n integer;
begin
 r1:=(public.group_mvp_execute('create',a,'{"name":"Chat one"}')#>>'{data,group,id}')::uuid;
 r2:=(public.group_mvp_execute('create',a,'{"name":"Chat two"}')#>>'{data,group,id}')::uuid;
 r3:=(public.group_mvp_execute('create',d,'{"name":"Retired sender"}')#>>'{data,group,id}')::uuid;
 insert into public.room_members(room_id,user_id) values(r1,b),(r1,q),(r2,q);
 insert into chat_test_context values(a,b,c,q,d,r1,r2,r3);
 result:=pg_temp.send(a,r1,'sensitive-test-body',client);
 assert (result->>'status')::int=201;
 m:=(result#>>'{data,message,id}')::uuid;
 assert result#>>'{data,message,room_seq}'='1';
 assert jsonb_typeof(result#>'{data,message,last_event_seq}')='string';
 assert (pg_temp.send(a,r1,'sensitive-test-body',client)->>'status')::int=200;
 assert (pg_temp.send(a,r1,'different',client)->>'status')::int=409;
 assert (pg_temp.send(a,r2,'sensitive-test-body',client)->>'status')::int=409;
 assert (pg_temp.send(c,r1,'outsider')->>'status')::int=404;
 assert (pg_temp.remove(b,r1,m)->>'status')::int=403;
 assert (pg_temp.remove(a,r2,m)->>'status')::int=404;
 result:=pg_temp.remove(a,r1,m);
 assert (result->>'status')::int=200;
 assert result#>'{data,message,body}'='null'::jsonb;
 assert result#>>'{data,message,last_event_seq}'='2';
 assert (pg_temp.remove(a,r1,m)#>>'{data,already_deleted}')::boolean;
 assert (select body is null and deleted_at is not null from public.messages where id=m);
 assert (select count(*)=2 from public.room_message_events where message_id=m);
 result:=pg_temp.send(a,r1,'not restored',client);
 assert (result->>'status')::int=200 and result#>'{data,message,body}'='null'::jsonb;
 result:=pg_temp.events(a,r1);
 assert position('sensitive-test-body' in result::text)=0;
 assert jsonb_array_length(result#>'{data,messages}')=1;
 assert not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='room_message_events' and column_name in ('body','old','payload','sender_id'));
 result:=pg_temp.events(a,r1,'0',1); cursor:=result#>'{data,next_cursor}';
 assert result#>>'{data,through_event_seq}'='2';
 assert (pg_temp.send(a,r1,'later')->>'status')::int=201;
 page:=pg_temp.events(a,r1,'0',1,cursor);
 assert page#>>'{data,through_event_seq}'='2';
 assert page#>>'{data,next_after_event_seq}'='2';
 assert page#>>'{data,events,0,type}'='deleted';
 assert (pg_temp.events(a,r1,'2')#>>'{data,events,0,event_seq}')='3';

 assert (pg_temp.send(a,r1,repeat('あ',499))->>'status')::int=201;
 assert (pg_temp.send(a,r1,repeat(U&'\+01F600',500))->>'status')::int=201;
 assert (pg_temp.send(a,r1,repeat('あ',501))->>'status')::int=400;
 assert (pg_temp.send(a,r1,'')->>'status')::int=400;
 assert (pg_temp.send(a,r1,null)->>'status')::int=400;
 assert (pg_temp.send(a,r1,U&'\0020\00A0\3000\2009\000A')->>'status')::int=400;
 result:=pg_temp.send(a,r1,E'line\r\nline');
 assert (result->>'status')::int=201 and result#>>'{data,message,body}'=E'line\nline';
 result:=pg_temp.history(a,r1,2); cursor:=result#>'{data,next_cursor}';
 assert (result#>>'{data,has_more}')::boolean;
 assert jsonb_array_length(pg_temp.history(a,r1,2,cursor)#>'{data,messages}')=2;
 assert (pg_temp.history(a,r2,2,cursor)->>'status')::int=400;
 assert (pg_temp.events(a,r1,'9223372036854775808')->>'status')::int=400;
 assert (pg_temp.events(a,r1,'-1')->>'status')::int=400;
 assert (pg_temp.events(a,r1,'99999')->>'status')::int=400;
 assert (pg_temp.history(a,r1,101)->>'status')::int=400;
 assert (pg_temp.history(a,r1,50,'1'::jsonb)->>'status')::int=400;
 assert (pg_temp.events(a,r1,'0',50,'[]'::jsonb)->>'status')::int=400;
 assert (pg_temp.history(c,r1)->>'status')::int=404;

 -- Strict rolling quota across BOTH rooms, including the tombstone.
 for n in 1..10 loop
   result:=pg_temp.send(q,case when n%2=0 then r1 else r2 end,'quota');
   assert (result->>'status')::int=201;
 end loop;
 select id,client_message_id into m,client from public.messages where sender_id=q order by created_at limit 1;
 assert (pg_temp.remove(q,r2,m)->>'status')::int=200;
 result:=pg_temp.send(q,r1,'eleventh');
 assert (result->>'status')::int=429;
 assert (result#>>'{data,retry_after_seconds}')::integer between 1 and 60;
 assert (pg_temp.send(q,r2,'quota',client)->>'status')::int=200;
 assert (select count(*)=10 from public.messages where sender_id=q);
end $$;

-- Even a privileged operator cannot accidentally edit/restore/purge through DML.
do $$ declare m public.messages%rowtype; denied boolean; begin
 select * into m from public.messages where deleted_at is not null limit 1;
 denied:=false;
 begin update public.messages set body='resurrection',deleted_at=null where id=m.id;
 exception when raise_exception then denied:=true; end;
 assert denied;
 denied:=false;
 begin delete from public.messages where id=m.id;
 exception when raise_exception then denied:=true; end;
 assert denied;
 select * into m from public.messages where deleted_at is null limit 1;
 denied:=false;
 begin update public.messages set body='edited' where id=m.id;
 exception when raise_exception then denied:=true; end;
 assert denied;
 denied:=false;
 begin update public.room_message_events set event_type=event_type;
 exception when raise_exception then denied:=true; end;
 assert denied;
end $$;

-- Age only synthetic rows to exercise expiry without a 60-second sleep.
alter table public.messages disable trigger chat_message_immutable;
update public.messages set created_at=clock_timestamp()-interval '59 seconds'
where sender_id='00000000-0000-4000-8000-000000000004';
alter table public.messages enable trigger chat_message_immutable;
do $$ declare x chat_test_context%rowtype; result jsonb; begin
 select * into x from chat_test_context;
 result:=pg_temp.send(x.q,x.r1,'still full'); assert (result->>'status')::int=429;
end $$;
alter table public.messages disable trigger chat_message_immutable;
update public.messages set created_at=clock_timestamp()-interval '60 seconds'
where id=(select id from public.messages where sender_id='00000000-0000-4000-8000-000000000004' order by id limit 1);
alter table public.messages enable trigger chat_message_immutable;
do $$ declare x chat_test_context%rowtype; begin
 select * into x from chat_test_context;
 assert (pg_temp.send(x.q,x.r1,'after expiry')->>'status')::int=201;
 -- Exact interval predicate, independent of machine scheduling.
 assert not (timestamptz '2026-01-01 00:00:00Z' > timestamptz '2026-01-01 00:01:00Z'-interval '60 seconds');
 assert timestamptz '2026-01-01 00:00:00.000001Z' > timestamptz '2026-01-01 00:01:00Z'-interval '60 seconds';
end $$;

-- RLS never broadens room_members access; test a connected user's next query.
do $$ declare x chat_test_context%rowtype; n integer; begin
 select * into x from chat_test_context;
 perform set_config('request.jwt.claim.sub',x.b::text,true);
 set local role authenticated;
 select count(*) into n from public.room_message_events where room_id=x.r1;
 assert n>0;
 reset role;
 perform public.group_mvp_execute('leave',x.b,jsonb_build_object('room_id',x.r1));
 set local role authenticated;
 select count(*) into n from public.room_message_events where room_id=x.r1;
 assert n=0,'RLS still permits a departed member';
 reset role;
 assert (pg_temp.events(x.b,x.r1)->>'status')::int=404;
 assert (pg_temp.history(x.b,x.r1)->>'status')::int=404;
 assert (pg_temp.send(x.b,x.r1,'departed')->>'status')::int=404;
 perform public.group_mvp_execute('join',x.b,jsonb_build_object('invite_code',(select room_key from public.rooms where id=x.r1)));
 assert jsonb_array_length(pg_temp.history(x.b,x.r1)#>'{data,messages}')>0;
end $$;

-- Inject event failure: message INSERT and send quota must roll back together.
create function pg_temp.reject_chat_event() returns trigger language plpgsql as $$
begin raise exception 'injected event failure'; end $$;
create trigger test_reject_chat_event before insert on public.room_message_events
for each row execute function pg_temp.reject_chat_event();
do $$ declare x chat_test_context%rowtype; n integer; begin
 select * into x from chat_test_context;
 select count(*) into n from public.messages;
 begin
   perform pg_temp.send(x.b,x.r1,'must rollback'); raise exception 'Expected injected failure';
 exception when raise_exception then if sqlerrm<>'injected event failure' then raise; end if; end;
 assert (select count(*)=n from public.messages);
end $$;
drop trigger test_reject_chat_event on public.room_message_events;

do $$ declare x chat_test_context%rowtype; r jsonb; m uuid; begin
 select * into x from chat_test_context;
 r:=pg_temp.send(x.d,x.r3,'Account retained body'); m:=(r#>>'{data,message,id}')::uuid;
 delete from auth.users where id=x.d;
 assert (select sender_id is null and body='Account retained body' from public.messages where id=m);
 assert (select count(*)=1 from public.room_message_events where message_id=m);
 -- Last-departure archive is a distinct group, not the account-deletion case.
 x.r3:=(public.group_mvp_execute('create',x.b,'{"name":"Archive"}')#>>'{data,group,id}')::uuid;
 perform pg_temp.send(x.b,x.r3,'archive history');
 perform public.group_mvp_execute('leave',x.b,jsonb_build_object('room_id',x.r3));
 assert (pg_temp.history(x.b,x.r3)->>'status')::int=404;
 assert (pg_temp.events(x.b,x.r3)->>'status')::int=404;
 assert (pg_temp.send(x.b,x.r3,'closed')->>'status')::int=404;
end $$;

-- ACL + publication metadata checks under broad default privileges.
do $$ declare r text; f text; t text; p text; denied boolean; begin
 foreach r in array array['anon','authenticated'] loop
  foreach f in array array['public.chat_send_message(uuid,uuid,text,uuid)',
    'public.chat_delete_message(uuid,uuid,uuid)','public.chat_list_messages(uuid,uuid,integer,jsonb)',
    'public.chat_list_message_events(uuid,uuid,text,integer,jsonb)'] loop
    assert not has_function_privilege(r,f,'EXECUTE');
  end loop;
  foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    assert not has_table_privilege(r,'public.messages',p);
    if r<>'authenticated' or p<>'SELECT' then assert not has_table_privilege(r,'public.room_message_events',p); end if;
  end loop;
  execute format('set local role %I',r); denied:=false;
  begin perform public.chat_send_message(gen_random_uuid(),gen_random_uuid(),'forged',gen_random_uuid());
    exception when insufficient_privilege then denied:=true; end;
  reset role; assert denied;
 end loop;
 assert not has_table_privilege('authenticated','public.room_members','SELECT');
 assert not has_function_privilege('authenticated','chat_private.message_json(public.messages)','EXECUTE');
 assert not has_table_privilege('service_role','public.messages','DELETE');
 assert not has_table_privilege('service_role','public.room_message_events','UPDATE');
 assert not has_table_privilege('service_role','public.room_message_events','DELETE');
 assert (select count(*)=1 from pg_publication_tables where pubname='supabase_realtime' and tablename='room_message_events');
 assert not exists(select 1 from pg_publication_tables where tablename='messages');
 assert (select count(*)=2 from public.rooms where room_key in ('Legacy1','Legacy2') and mvp_created_by is null and mvp_archived_at is null);
end $$;
rollback;
