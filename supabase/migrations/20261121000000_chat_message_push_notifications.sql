-- Issue #36. Forward migration; historical migrations and their ACLs stay intact.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 OR to_regprocedure('public.chat_send_message(uuid,uuid,text,uuid)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='free_period_id' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'Reviewed postgres owner and hardened chat/timer baseline required'; END IF;
END $$;

CREATE SCHEMA chat_push_private;
REVOKE ALL ON SCHEMA chat_push_private FROM PUBLIC,anon,authenticated,service_role;

-- A timestamp cannot identify a membership incarnation reliably (same transaction
-- rejoin, imported timestamps). Role-only updates must preserve this generation.
ALTER TABLE public.room_members ADD COLUMN push_membership_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION chat_push_private.membership_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='INSERT' OR (NEW.room_id,NEW.user_id) IS DISTINCT FROM (OLD.room_id,OLD.user_id) THEN
  NEW.push_membership_id:=gen_random_uuid();
 ELSIF NEW.push_membership_id IS DISTINCT FROM OLD.push_membership_id THEN
  RAISE EXCEPTION 'Membership generation is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chat_push_membership_generation BEFORE INSERT OR UPDATE ON public.room_members
FOR EACH ROW EXECUTE FUNCTION chat_push_private.membership_generation();

CREATE TABLE public.chat_message_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE RESTRICT,
 room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
 recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 recipient_period_id uuid NOT NULL,
 recipient_membership_id uuid NOT NULL,
 sender_name text NOT NULL,
 message_created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','failed','sent','cancelled','expired','exhausted')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,
 lease_expires_at timestamptz,
 accepted_count integer NOT NULL DEFAULT 0 CHECK(accepted_count>=0),
 sent_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(message_id,recipient_user_id),
 CHECK(expires_at=message_created_at+interval '5 minutes'),
 CHECK(status<>'sent' OR accepted_count>0)
);
CREATE INDEX chat_message_notifications_due_idx ON public.chat_message_notifications(next_attempt_at,created_at,id)
 WHERE status IN('pending','failed','processing');
ALTER TABLE public.chat_message_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_message_notifications FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat_push_private.enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET row_security=off AS $$
DECLARE m public.messages%rowtype; snapshot_name text; checked_at timestamptz:=clock_timestamp();
BEGIN
 IF NEW.event_type<>'created' THEN RETURN NEW; END IF;
 SELECT * INTO STRICT m FROM public.messages WHERE id=NEW.message_id AND room_id=NEW.room_id;
 SELECT left(coalesce(nullif(btrim(p.username),''),'メンバー'),2000) INTO snapshot_name FROM public.profiles p WHERE p.id=m.sender_id;
 -- One statement fixes the recipients, ON periods and membership generations.
 -- Do not require the sender to be ON; do not fan out again on RPC retries.
 INSERT INTO public.chat_message_notifications(message_id,room_id,recipient_user_id,recipient_period_id,
  recipient_membership_id,sender_name,message_created_at,expires_at)
 SELECT m.id,m.room_id,p.id,p.free_period_id,rm.push_membership_id,coalesce(snapshot_name,'メンバー'),m.created_at,m.created_at+interval '5 minutes'
 FROM public.room_members rm JOIN public.profiles p ON p.id=rm.user_id
 JOIN public.rooms r ON r.id=rm.room_id
 WHERE rm.room_id=m.room_id AND p.id<>m.sender_id AND p.is_free IS TRUE
 AND (p.free_until IS NULL OR p.free_until>checked_at) AND p.free_period_id IS NOT NULL
 AND r.mvp_archived_at IS NULL AND m.deleted_at IS NULL AND m.created_at+interval '5 minutes'>checked_at;
 RETURN NEW;
END $$;
CREATE TRIGGER chat_push_enqueue AFTER INSERT ON public.room_message_events
FOR EACH ROW WHEN(NEW.event_type='created') EXECUTE FUNCTION chat_push_private.enqueue();

CREATE FUNCTION chat_push_private.cancel_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET row_security=off AS $$ BEGIN
 UPDATE public.chat_message_notifications SET status='cancelled',lease_expires_at=NULL,
 last_error='Message deleted',updated_at=clock_timestamp()
 WHERE message_id=NEW.id AND status IN('pending','failed','processing');
 RETURN NEW;
END $$;
CREATE TRIGGER chat_push_cancel_deleted AFTER UPDATE ON public.messages FOR EACH ROW
WHEN(OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION chat_push_private.cancel_deleted();

CREATE FUNCTION chat_push_private.is_valid(p_notification uuid,p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.chat_message_notifications n
 JOIN public.messages m ON m.id=n.message_id AND m.room_id=n.room_id
 JOIN public.rooms r ON r.id=n.room_id
 JOIN public.profiles p ON p.id=n.recipient_user_id
 JOIN public.room_members rm ON rm.room_id=n.room_id AND rm.user_id=n.recipient_user_id
 WHERE n.id=p_notification AND n.expires_at>p_at AND m.deleted_at IS NULL AND r.mvp_archived_at IS NULL
 AND p.is_free IS TRUE AND (p.free_until IS NULL OR p.free_until>p_at)
 AND p.free_period_id=n.recipient_period_id AND rm.push_membership_id=n.recipient_membership_id);
$$;

CREATE FUNCTION public.claim_chat_message_notifications(p_limit integer DEFAULT 20,p_lease_seconds integer DEFAULT 120,p_max_attempts integer DEFAULT 3)
RETURNS TABLE(notification_id uuid,room_id uuid,message_id uuid,recipient_user_id uuid,lease_token uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET row_security=off SET lock_timeout='5s' AS $$
DECLARE checked_at timestamptz:=clock_timestamp();
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 3600
 OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid chat notification claim options'; END IF;
 WITH stale AS (
  SELECT n.id FROM public.chat_message_notifications n WHERE n.status IN('pending','failed','processing')
  AND (n.expires_at<=checked_at OR ((n.status<>'processing' OR n.lease_expires_at<=checked_at)
   AND (NOT chat_push_private.is_valid(n.id,checked_at) OR n.attempts>=n.max_attempts)))
  ORDER BY n.created_at,n.id FOR UPDATE SKIP LOCKED
 ) UPDATE public.chat_message_notifications n SET
 status=CASE WHEN n.expires_at<=checked_at THEN 'expired' WHEN NOT chat_push_private.is_valid(n.id,checked_at) THEN 'cancelled' ELSE 'exhausted' END,
 lease_expires_at=NULL,updated_at=checked_at FROM stale s WHERE n.id=s.id;
 RETURN QUERY WITH candidates AS (
  SELECT n.id FROM public.chat_message_notifications n
  WHERE n.expires_at>checked_at AND n.next_attempt_at<=checked_at AND n.attempts<n.max_attempts
  AND (n.status IN('pending','failed') OR (n.status='processing' AND n.lease_expires_at<=checked_at))
  AND chat_push_private.is_valid(n.id,checked_at)
  ORDER BY n.created_at,n.id LIMIT p_limit FOR UPDATE SKIP LOCKED
 ), claimed AS (
  UPDATE public.chat_message_notifications n SET status='processing',attempts=n.attempts+1,
  max_attempts=CASE WHEN n.attempts=0 THEN p_max_attempts ELSE n.max_attempts END,
  lease_token=gen_random_uuid(),lease_expires_at=checked_at+make_interval(secs=>p_lease_seconds),updated_at=checked_at
  FROM candidates c WHERE n.id=c.id RETURNING n.*
 ) SELECT c.id,c.room_id,c.message_id,c.recipient_user_id,c.lease_token,c.expires_at FROM claimed c;
END $$;

CREATE FUNCTION public.validate_chat_message_notification(p_notification uuid,p_lease_token uuid)
RETURNS TABLE(owned boolean,still_valid boolean,sender_name text,message_body text,remaining_ms double precision,expiration bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET row_security=off AS $$
DECLARE checked_at timestamptz:=clock_timestamp();
BEGIN
 RETURN QUERY SELECT
 coalesce(n.status='processing' AND n.lease_token=p_lease_token AND n.lease_expires_at>checked_at,false),
 chat_push_private.is_valid(n.id,checked_at),
 n.sender_name,CASE WHEN m.deleted_at IS NULL THEN m.body ELSE NULL END,
 greatest(0,extract(epoch FROM least(n.expires_at,n.lease_expires_at)-checked_at)*1000)::double precision,
 floor(extract(epoch FROM n.expires_at))::bigint
 FROM public.chat_message_notifications n JOIN public.messages m ON m.id=n.message_id WHERE n.id=p_notification;
END $$;

CREATE FUNCTION public.complete_chat_message_notification(p_notification uuid,p_lease_token uuid,p_status text,p_error text DEFAULT NULL,p_accepted_count integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET row_security=off SET lock_timeout='5s' AS $$
DECLARE checked_at timestamptz:=clock_timestamp(); changed integer;
BEGIN
 IF p_notification IS NULL OR p_lease_token IS NULL OR p_status IS NULL OR p_status NOT IN('sent','failed','cancelled')
 OR p_accepted_count IS NULL OR p_accepted_count<0 OR (p_status='sent')<>(p_accepted_count>0) THEN RAISE EXCEPTION 'Invalid chat notification completion'; END IF;
 -- Keep confirmed acceptance even if deletion/expiry occurred after sending.
 -- Cancellation/expiry/exhaustion retain the token; a superseded lease can
 -- NEVER complete it. This records historical acceptance, not send permission.
 UPDATE public.chat_message_notifications n SET
 status=CASE WHEN p_status='sent' THEN 'sent' WHEN n.expires_at<=checked_at THEN 'expired'
 WHEN p_status='cancelled' OR NOT chat_push_private.is_valid(n.id,checked_at) THEN 'cancelled'
 WHEN n.attempts>=n.max_attempts THEN 'exhausted' ELSE 'failed' END,
 accepted_count=p_accepted_count,sent_at=CASE WHEN p_status='sent' THEN checked_at ELSE NULL END,
 last_error=left(p_error,1000),lease_expires_at=NULL,updated_at=checked_at,
 next_attempt_at=CASE WHEN p_status='failed' THEN least(n.expires_at,checked_at+make_interval(secs=>least(300,5*power(2,n.attempts-1))::integer)) ELSE n.next_attempt_at END
 WHERE n.id=p_notification AND n.lease_token=p_lease_token
 AND (n.status='processing' OR (p_status='sent' AND n.status IN('cancelled','expired','exhausted')));
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 THEN RETURN true; END IF;
 -- An identical sent acknowledgement is idempotent and never changes the
 -- original accepted count or timestamp; other terminal updates are refused.
 RETURN p_status='sent' AND EXISTS(SELECT 1 FROM public.chat_message_notifications n
  WHERE n.id=p_notification AND n.lease_token=p_lease_token AND n.status='sent' AND n.accepted_count=p_accepted_count);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat_push_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_chat_message_notifications(integer,integer,integer),
 public.validate_chat_message_notification(uuid,uuid),public.complete_chat_message_notification(uuid,uuid,text,text,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_chat_message_notifications(integer,integer,integer),
 public.validate_chat_message_notification(uuid,uuid),public.complete_chat_message_notification(uuid,uuid,text,text,integer) TO service_role;
COMMIT;
