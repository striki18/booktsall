-- Inbox and register changes must go through trusted server workflows.
BEGIN;

ALTER TABLE public.inbox_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_evidence_register ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_documents_company_scope ON public.inbox_documents;
CREATE POLICY inbox_documents_company_scope ON public.inbox_documents
  FOR SELECT TO authenticated
  USING (realm_id = (SELECT auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS qbo_evidence_register_company_scope ON public.qbo_evidence_register;
CREATE POLICY qbo_evidence_register_company_scope ON public.qbo_evidence_register
  FOR SELECT TO authenticated
  USING (realm_id = (SELECT auth.jwt() -> 'app_metadata' ->> 'realm_id'));

-- Remove direct grants at table and column level, including TRUNCATE, which
-- row-level security does not cover. Keep existing service-role grants.
REVOKE ALL PRIVILEGES ON TABLE public.inbox_documents, public.qbo_evidence_register
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inbox_documents, public.qbo_evidence_register TO authenticated;

DO $$
DECLARE
  evidence_table regclass;
  client_role text;
BEGIN
  FOREACH evidence_table IN ARRAY ARRAY['public.inbox_documents'::regclass, 'public.qbo_evidence_register'::regclass]
  LOOP
    -- Check effective permissions so a grant inherited from another role
    -- cannot silently bypass the permissions above.
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF pg_catalog.has_any_column_privilege(client_role, evidence_table, 'INSERT, UPDATE, REFERENCES')
        OR pg_catalog.has_table_privilege(client_role, evidence_table, 'DELETE, TRUNCATE, TRIGGER') THEN
        RAISE EXCEPTION 'Unexpected write privileges remain for % on %', client_role, evidence_table;
      END IF;
    END LOOP;

    IF pg_catalog.has_any_column_privilege('anon', evidence_table, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('authenticated', evidence_table, 'SELECT') THEN
      RAISE EXCEPTION 'Unexpected read privileges on %', evidence_table;
    END IF;

    IF NOT pg_catalog.has_table_privilege('service_role', evidence_table, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', evidence_table, 'INSERT')
      OR NOT pg_catalog.has_table_privilege('service_role', evidence_table, 'UPDATE')
      OR (evidence_table = 'public.qbo_evidence_register'::regclass
        AND NOT pg_catalog.has_table_privilege('service_role', evidence_table, 'DELETE')) THEN
      RAISE EXCEPTION 'Required server privileges are missing on %', evidence_table;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = evidence_table AND policy.polpermissive AND policy.polcmd IN ('*', 'r')
        AND policy.polname <> CASE WHEN evidence_table = 'public.inbox_documents'::regclass
          THEN 'inbox_documents_company_scope' ELSE 'qbo_evidence_register_company_scope' END
        AND EXISTS (
          SELECT 1 FROM pg_catalog.unnest(policy.polroles) AS policy_role(role_oid)
          WHERE CASE WHEN role_oid = 0 THEN true
            ELSE pg_catalog.pg_has_role('authenticated', role_oid, 'MEMBER') END
        )
    ) THEN
      RAISE EXCEPTION 'Unexpected permissive read policy on %', evidence_table;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
