BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

-- Block legacy writes between the preflight and the schema change.
LOCK TABLE public.user_device_tokens IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.user_device_tokens WHERE installation_id IS NULL)
        OR EXISTS (SELECT 1 FROM push_private.legacy_registration_sessions) THEN
        RAISE EXCEPTION 'Legacy device registrations must be reviewed and removed before migration 33';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION push_private.guard_managed_device_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE actor_session uuid;
DECLARE actor uuid;
BEGIN
    IF TG_TABLE_NAME='logout_recoveries' THEN
        actor_session := NEW.scope_session;
        actor := NEW.scope_user;
    ELSE
        actor_session := NEW.session_id;
        actor := NEW.user_id;
    END IF;
    IF actor_session IS NULL THEN RETURN NEW; END IF;
    PERFORM push_private.lock_device_session(actor_session);
    IF TG_OP='INSERT' AND NOT push_private.lock_live_device_auth(actor,actor_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.authorize_notification_delivery(p_kind text,p_notification uuid,p_lease uuid,p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off SET lock_timeout = '1500ms' AS $$
DECLARE recipient uuid;
DECLARE occurred timestamptz;
DECLARE due_at timestamptz;
DECLARE lease_until timestamptz;
DECLARE owned boolean;
DECLARE valid boolean;
DECLARE candidate_ids uuid[];
DECLARE cursor_id uuid;
DECLARE deliveries jsonb;
BEGIN
    CASE p_kind
    WHEN 'free_end' THEN
        SELECT c.user_id,least(c.created_at,c.free_until-interval '5 minutes'),c.free_until
            INTO recipient,occurred,due_at FROM public.free_end_notification_claims c WHERE c.id=p_notification;
    WHEN 'member_free' THEN
        SELECT n.recipient_user_id,e.occurred_at INTO recipient,occurred FROM public.member_free_notifications n
            JOIN public.member_free_events e ON e.id=n.event_id WHERE n.id=p_notification;
    WHEN 'chat_message' THEN
        SELECT n.recipient_user_id,n.message_created_at,n.expires_at INTO recipient,occurred,due_at
            FROM public.chat_message_notifications n WHERE n.id=p_notification;
    ELSE
        RAISE EXCEPTION 'Invalid notification type' USING ERRCODE='22023';
    END CASE;
    SELECT array_agg(c.id ORDER BY c.id) INTO candidate_ids FROM (
        SELECT t.id FROM public.user_device_tokens t WHERE t.user_id=recipient AND (p_after IS NULL OR t.id>p_after)
        ORDER BY t.id LIMIT 100
    ) c;
    -- Lock in UUID order, before reading the final binding and token snapshot.
    -- Logout and managed token registration lock the same installation row.
    PERFORM 1 FROM push_private.installations i
        WHERE i.installation_id IN (SELECT t.installation_id FROM public.user_device_tokens t WHERE t.id=ANY(candidate_ids))
        ORDER BY i.installation_id FOR UPDATE;
    CASE p_kind
    WHEN 'free_end' THEN
        PERFORM 1 FROM public.free_end_notification_claims WHERE id=p_notification FOR UPDATE;
        SELECT v.owned,v.still_valid,c.lease_expires_at INTO owned,valid,lease_until
            FROM public.free_end_notification_claims c
            CROSS JOIN LATERAL public.validate_free_end_notification(c.id,p_lease) v WHERE c.id=p_notification;
    WHEN 'member_free' THEN
        PERFORM 1 FROM public.member_free_notifications WHERE id=p_notification FOR UPDATE;
        SELECT v.owned,v.still_valid
            AND (a.free_until IS NULL OR a.free_until>clock_timestamp())
            AND (b.free_until IS NULL OR b.free_until>clock_timestamp()),n.lease_expires_at INTO owned,valid,lease_until
            FROM public.member_free_notifications n
            JOIN public.member_free_events e ON e.id=n.event_id
            JOIN public.profiles a ON a.id=e.actor_user_id
            JOIN public.profiles b ON b.id=n.recipient_user_id
            CROSS JOIN LATERAL public.validate_member_free_notification(n.id,p_lease) v WHERE n.id=p_notification;
    WHEN 'chat_message' THEN
        PERFORM 1 FROM public.chat_message_notifications WHERE id=p_notification FOR UPDATE;
        SELECT v.owned,v.still_valid,n.lease_expires_at INTO owned,valid,lease_until
            FROM public.chat_message_notifications n
            CROSS JOIN LATERAL public.validate_chat_message_notification(n.id,p_lease) v WHERE n.id=p_notification;
    END CASE;
    IF owned IS DISTINCT FROM true OR valid IS DISTINCT FROM true OR lease_until IS NULL
        OR lease_until<=clock_timestamp() OR (due_at IS NOT NULL AND due_at<=clock_timestamp()) THEN
        RETURN jsonb_build_object('eligible',false,'targets','[]'::jsonb,'cursor',NULL);
    END IF;
    SELECT jsonb_agg(jsonb_build_object('id',t.id,'userId',t.user_id,'token',t.expo_push_token,
        'installationId',t.installation_id,'generation',t.generation::text,
        'revision',t.registration_revision::text,'version',t.delivery_version) ORDER BY t.id)
    INTO deliveries FROM public.user_device_tokens t
    LEFT JOIN push_private.installation_bindings b ON b.installation_id=t.installation_id
        AND b.generation=t.generation AND b.user_id=t.user_id
    WHERE t.id=ANY(candidate_ids) AND t.user_id=recipient
        AND b.generation IS NOT NULL AND b.fenced_at IS NULL AND b.created_at<=occurred AND t.registration_revision>0;
    IF cardinality(candidate_ids)=100 THEN cursor_id:=candidate_ids[100]; END IF;
    RETURN jsonb_build_object('eligible',true,'targets',coalesce(deliveries,'[]'::jsonb),'cursor',cursor_id);
END $$;

DROP FUNCTION public.upsert_device_token(text,text,text);
DROP FUNCTION public.list_legacy_test_push_tokens(uuid);
DROP POLICY "own tokens select" ON public.user_device_tokens;
DROP POLICY "own tokens delete" ON public.user_device_tokens;
REVOKE ALL ON public.user_device_tokens FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION push_private.live_legacy_device_jwt();
DROP FUNCTION push_private.jwt_device_session();
DROP TABLE push_private.legacy_registration_sessions;
ALTER TABLE public.user_device_tokens
    ALTER COLUMN installation_id SET NOT NULL,
    ALTER COLUMN generation SET NOT NULL,
    ALTER COLUMN registration_revision SET NOT NULL;
COMMIT;
