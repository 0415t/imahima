BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.user_device_tokens ADD COLUMN delivery_version uuid NOT NULL DEFAULT gen_random_uuid();

CREATE FUNCTION push_private.rotate_token_delivery_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    NEW.delivery_version := gen_random_uuid();
    RETURN NEW;
END $$;
CREATE TRIGGER rotate_token_delivery_version BEFORE INSERT OR UPDATE ON public.user_device_tokens
    FOR EACH ROW EXECUTE FUNCTION push_private.rotate_token_delivery_version();

-- Old binary paths cannot fetch managed tokens. App access still uses its own
-- authenticated role and existing policies.
REVOKE SELECT, DELETE ON public.user_device_tokens FROM service_role;
REVOKE SELECT (id,user_id,expo_push_token,platform,device_name,created_at,updated_at,
    installation_id,generation,registration_revision,delivery_version) ON public.user_device_tokens FROM service_role;

CREATE FUNCTION public.list_legacy_test_push_tokens(p_user uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
    SELECT t.expo_push_token FROM public.user_device_tokens t
    WHERE t.user_id=p_user AND t.installation_id IS NULL
$$;

CREATE FUNCTION public.authorize_notification_delivery(p_kind text,p_notification uuid,p_lease uuid,p_after uuid DEFAULT NULL)
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
        AND (t.installation_id IS NULL OR
            (b.generation IS NOT NULL AND b.fenced_at IS NULL AND b.created_at<=occurred
                AND t.registration_revision>0));
    IF cardinality(candidate_ids)=100 THEN cursor_id:=candidate_ids[100]; END IF;
    RETURN jsonb_build_object('eligible',true,'targets',coalesce(deliveries,'[]'::jsonb),'cursor',cursor_id);
END $$;

CREATE FUNCTION public.delete_invalid_notification_registration(
    p_id uuid,p_user uuid,p_installation uuid,p_generation bigint,p_revision bigint,p_version uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
BEGIN
    IF p_installation IS NOT NULL THEN
        PERFORM 1 FROM push_private.installations WHERE installation_id=p_installation FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
    END IF;
    DELETE FROM public.user_device_tokens t WHERE t.id=p_id AND t.user_id=p_user
        AND t.installation_id IS NOT DISTINCT FROM p_installation AND t.generation IS NOT DISTINCT FROM p_generation
        AND t.registration_revision IS NOT DISTINCT FROM p_revision AND t.delivery_version=p_version;
    RETURN FOUND;
END $$;

ALTER FUNCTION public.authorize_notification_delivery(text,uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.delete_invalid_notification_registration(uuid,uuid,uuid,bigint,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_legacy_test_push_tokens(uuid) OWNER TO postgres;
ALTER FUNCTION push_private.rotate_token_delivery_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.rotate_token_delivery_version(),
    public.authorize_notification_delivery(text,uuid,uuid,uuid),
    public.delete_invalid_notification_registration(uuid,uuid,uuid,bigint,bigint,uuid),
    public.list_legacy_test_push_tokens(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_notification_delivery(text,uuid,uuid,uuid),
    public.delete_invalid_notification_registration(uuid,uuid,uuid,bigint,bigint,uuid),
    public.list_legacy_test_push_tokens(uuid) TO service_role;
COMMIT;
