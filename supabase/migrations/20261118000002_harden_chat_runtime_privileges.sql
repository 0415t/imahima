-- Issue #35: additive hardening; never replays historical migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE target text; relation_oid oid; columns_sql text; signature text;
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Reviewed postgres execution role required'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') AND rolsuper)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated') AND rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname IN ('anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Unexpected application role configuration';
  END IF;
  FOREACH signature IN ARRAY ARRAY['chat_private.valid_body(text)','chat_private.can_read_room(uuid)','chat_private.guard_message()','chat_private.guard_event()','chat_private.error(integer,text,text)','chat_private.actor_error(uuid)','chat_private.sequence_value(text)','chat_private.message_json(public.messages)','public.chat_send_message(uuid,uuid,text,uuid)','public.chat_delete_message(uuid,uuid,uuid)','public.chat_list_messages(uuid,uuid,integer,jsonb)','public.chat_list_message_events(uuid,uuid,text,integer,jsonb)']::text[] LOOP
    IF pg_catalog.to_regprocedure(signature) IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(signature) AND proowner=current_user::regrole AND prokind='f') THEN
      RAISE EXCEPTION 'Missing or unexpected function owner: %', signature;
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['messages','room_message_events']::text[] LOOP
    relation_oid := pg_catalog.to_regclass(pg_catalog.format('public.%I',target));
    IF relation_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=relation_oid AND relkind='r' AND relowner=current_user::regrole AND relrowsecurity AND NOT relforcerowsecurity) THEN
      RAISE EXCEPTION 'Unexpected target table metadata: %',target;
    END IF;
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(attname),', ' ORDER BY attnum) INTO columns_sql
      FROM pg_catalog.pg_attribute WHERE attrelid=relation_oid AND attnum>0 AND NOT attisdropped;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',target);
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',columns_sql,target);
  END LOOP;
END
$guard$;
GRANT SELECT ON public.messages TO service_role;
GRANT INSERT (room_id,sender_id,room_seq,body,client_message_id,created_at,last_event_seq) ON public.messages TO service_role;
GRANT UPDATE (body,deleted_at,last_event_seq) ON public.messages TO service_role;
GRANT SELECT ON public.room_message_events TO authenticated,service_role;
GRANT INSERT (room_id,event_seq,message_id,event_type,created_at) ON public.room_message_events TO service_role;
REVOKE ALL PRIVILEGES ON SCHEMA chat_private FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA chat_private TO authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION
  chat_private.valid_body(text),
  chat_private.can_read_room(uuid),
  chat_private.guard_message(),
  chat_private.guard_event(),
  chat_private.error(integer,text,text),
  chat_private.actor_error(uuid),
  chat_private.sequence_value(text),
  chat_private.message_json(public.messages),
  public.chat_send_message(uuid,uuid,text,uuid),
  public.chat_delete_message(uuid,uuid,uuid),
  public.chat_list_messages(uuid,uuid,integer,jsonb),
  public.chat_list_message_events(uuid,uuid,text,integer,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  chat_private.can_read_room(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION
  chat_private.valid_body(text),
  chat_private.error(integer,text,text),
  chat_private.actor_error(uuid),
  chat_private.sequence_value(text),
  chat_private.message_json(public.messages),
  public.chat_send_message(uuid,uuid,text,uuid),
  public.chat_delete_message(uuid,uuid,uuid),
  public.chat_list_messages(uuid,uuid,integer,jsonb),
  public.chat_list_message_events(uuid,uuid,text,integer,jsonb) TO service_role;
COMMIT;
