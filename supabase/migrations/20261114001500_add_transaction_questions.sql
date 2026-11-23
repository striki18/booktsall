-- Company-scoped, auditable questions attached to QBO transactions.
BEGIN;

CREATE TABLE public.transaction_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  qbo_txn_id text NOT NULL,
  qbo_txn_type text,
  qbo_txn_date date,
  qbo_txn_vendor text,
  qbo_txn_amount numeric,
  qbo_txn_doc_number text,
  audience text NOT NULL CHECK (audience IN ('client', 'accountant')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'resolved')),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT transaction_questions_realm_id_id_uq UNIQUE (realm_id, id),
  CONSTRAINT transaction_questions_resolution_check CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    OR (status <> 'resolved' AND resolved_at IS NULL AND resolved_by IS NULL)
  )
);

CREATE INDEX transaction_questions_company_status_idx
  ON public.transaction_questions (realm_id, status, created_at DESC);
CREATE INDEX transaction_questions_transaction_idx
  ON public.transaction_questions (realm_id, qbo_txn_id, created_at DESC);

CREATE TABLE public.transaction_question_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  question_id uuid NOT NULL,
  author_role text NOT NULL CHECK (author_role IN ('firm', 'client', 'accountant')),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  author_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_question_messages_question_fk
    FOREIGN KEY (realm_id, question_id)
    REFERENCES public.transaction_questions (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT transaction_question_messages_author_check CHECK (
    (author_role = 'client' AND author_user_id IS NULL)
    OR (author_role IN ('firm', 'accountant') AND author_user_id IS NOT NULL)
  )
);

CREATE INDEX transaction_question_messages_question_idx
  ON public.transaction_question_messages (realm_id, question_id, created_at, id);

CREATE TABLE public.transaction_question_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  question_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'answered', 'resolved')),
  actor_role text NOT NULL CHECK (actor_role IN ('firm', 'client', 'accountant')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_question_events_question_fk
    FOREIGN KEY (realm_id, question_id)
    REFERENCES public.transaction_questions (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT transaction_question_events_actor_check CHECK (
    (actor_role = 'client' AND actor_user_id IS NULL)
    OR (actor_role IN ('firm', 'accountant') AND actor_user_id IS NOT NULL)
  )
);

CREATE INDEX transaction_question_events_question_idx
  ON public.transaction_question_events (realm_id, question_id, created_at, id);

CREATE FUNCTION public.reject_transaction_question_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Transaction question history is append-only';
END;
$$;

CREATE TRIGGER transaction_question_messages_append_only
  BEFORE UPDATE OR DELETE ON public.transaction_question_messages
  FOR EACH ROW EXECUTE FUNCTION public.reject_transaction_question_history_mutation();
CREATE TRIGGER transaction_question_messages_no_truncate
  BEFORE TRUNCATE ON public.transaction_question_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_transaction_question_history_mutation();
CREATE TRIGGER transaction_question_events_append_only
  BEFORE UPDATE OR DELETE ON public.transaction_question_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_transaction_question_history_mutation();
CREATE TRIGGER transaction_question_events_no_truncate
  BEFORE TRUNCATE ON public.transaction_question_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_transaction_question_history_mutation();

CREATE FUNCTION public.protect_transaction_question_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Transaction questions must be retained';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'answered_at' - 'resolved_at' - 'resolved_by')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'answered_at' - 'resolved_at' - 'resolved_by') THEN
    RAISE EXCEPTION 'Transaction question identity cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_questions_identity_guard
  BEFORE UPDATE OR DELETE ON public.transaction_questions
  FOR EACH ROW EXECUTE FUNCTION public.protect_transaction_question_identity();
CREATE TRIGGER transaction_questions_no_truncate
  BEFORE TRUNCATE ON public.transaction_questions
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_transaction_question_identity();

CREATE FUNCTION public.create_transaction_question(
  p_realm_id text, p_qbo_txn_id text, p_qbo_txn_type text, p_qbo_txn_date date,
  p_qbo_txn_vendor text, p_qbo_txn_amount numeric, p_qbo_txn_doc_number text,
  p_audience text, p_body text, p_actor_user_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE question_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.qbo_company_memberships WHERE realm_id = p_realm_id AND user_id = p_actor_user_id) THEN
    RAISE EXCEPTION 'Actor is not an authorized company member';
  END IF;
  INSERT INTO public.transaction_questions(
    realm_id,qbo_txn_id,qbo_txn_type,qbo_txn_date,qbo_txn_vendor,qbo_txn_amount,qbo_txn_doc_number,audience,created_by
  ) VALUES (
    p_realm_id,p_qbo_txn_id,p_qbo_txn_type,p_qbo_txn_date,p_qbo_txn_vendor,p_qbo_txn_amount,p_qbo_txn_doc_number,p_audience,p_actor_user_id
  ) RETURNING id INTO question_id;
  INSERT INTO public.transaction_question_messages(realm_id,question_id,author_role,body,author_user_id)
    VALUES(p_realm_id,question_id,'firm',p_body,p_actor_user_id);
  INSERT INTO public.transaction_question_events(realm_id,question_id,event_type,actor_role,actor_user_id)
    VALUES(p_realm_id,question_id,'created','firm',p_actor_user_id);
  RETURN question_id;
END;
$$;

CREATE FUNCTION public.answer_transaction_question(
  p_realm_id text, p_question_id uuid, p_body text, p_actor_role text, p_actor_user_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE question_row public.transaction_questions; message_id uuid; event_time timestamptz := now();
BEGIN
  SELECT * INTO question_row FROM public.transaction_questions
    WHERE realm_id=p_realm_id AND id=p_question_id FOR UPDATE;
  IF NOT FOUND OR question_row.status='resolved' THEN RAISE EXCEPTION 'Open question not found'; END IF;
  IF p_actor_role='client' AND (question_row.audience <> 'client' OR p_actor_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Client reply is not allowed';
  END IF;
  IF p_actor_role IN ('firm','accountant') AND (
    p_actor_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.qbo_company_memberships WHERE realm_id=p_realm_id AND user_id=p_actor_user_id)
  ) THEN RAISE EXCEPTION 'Actor is not an authorized company member'; END IF;
  IF p_actor_role NOT IN ('client','firm','accountant') THEN RAISE EXCEPTION 'Invalid answer role'; END IF;
  INSERT INTO public.transaction_question_messages(realm_id,question_id,author_role,body,author_user_id,created_at)
    VALUES(p_realm_id,p_question_id,p_actor_role,p_body,p_actor_user_id,event_time) RETURNING id INTO message_id;
  UPDATE public.transaction_questions SET status='answered', answered_at=event_time
    WHERE realm_id=p_realm_id AND id=p_question_id;
  INSERT INTO public.transaction_question_events(realm_id,question_id,event_type,actor_role,actor_user_id,created_at)
    VALUES(p_realm_id,p_question_id,'answered',p_actor_role,p_actor_user_id,event_time);
  RETURN message_id;
END;
$$;

CREATE FUNCTION public.resolve_transaction_question(
  p_realm_id text, p_question_id uuid, p_actor_user_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE event_time timestamptz := now();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.qbo_company_memberships WHERE realm_id=p_realm_id AND user_id=p_actor_user_id) THEN
    RAISE EXCEPTION 'Actor is not an authorized company member';
  END IF;
  UPDATE public.transaction_questions
    SET status='resolved', resolved_at=event_time, resolved_by=p_actor_user_id
    WHERE realm_id=p_realm_id AND id=p_question_id AND status<>'resolved';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.transaction_question_events(realm_id,question_id,event_type,actor_role,actor_user_id,created_at)
    VALUES(p_realm_id,p_question_id,'resolved','firm',p_actor_user_id,event_time);
  RETURN true;
END;
$$;

ALTER TABLE public.transaction_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_question_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_question_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY transaction_questions_company_select ON public.transaction_questions
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));
CREATE POLICY transaction_question_messages_company_select ON public.transaction_question_messages
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));
CREATE POLICY transaction_question_events_company_select ON public.transaction_question_events
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON public.transaction_questions, public.transaction_question_messages, public.transaction_question_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.transaction_questions, public.transaction_question_messages, public.transaction_question_events
  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.transaction_questions TO service_role;
GRANT SELECT, INSERT ON public.transaction_question_messages, public.transaction_question_events TO service_role;
REVOKE ALL ON FUNCTION public.reject_transaction_question_history_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.protect_transaction_question_identity() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_transaction_question(text,text,text,date,text,numeric,text,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.answer_transaction_question(text,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_transaction_question(text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_transaction_question(text,text,text,date,text,numeric,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.answer_transaction_question(text,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_transaction_question(text,uuid,uuid) TO service_role;

COMMIT;
