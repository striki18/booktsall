CREATE TABLE IF NOT EXISTS public.qbo_company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  realm_id text NOT NULL,
  company_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qbo_company_memberships_user_realm_unique UNIQUE (user_id, realm_id)
);

CREATE INDEX IF NOT EXISTS idx_qbo_company_memberships_user
  ON public.qbo_company_memberships (user_id, realm_id);

ALTER TABLE public.qbo_company_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qbo_company_memberships_read_own ON public.qbo_company_memberships;
CREATE POLICY qbo_company_memberships_read_own
  ON public.qbo_company_memberships
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.qbo_company_memberships FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.qbo_company_memberships FROM authenticated;
GRANT SELECT ON TABLE public.qbo_company_memberships TO authenticated;
GRANT ALL ON TABLE public.qbo_company_memberships TO service_role;

-- Preserve existing single-company connections as memberships.
INSERT INTO public.qbo_company_memberships (user_id, realm_id)
SELECT id, raw_app_meta_data ->> 'realm_id'
FROM auth.users
WHERE NULLIF(raw_app_meta_data ->> 'realm_id', '') IS NOT NULL
ON CONFLICT (user_id, realm_id) DO NOTHING;
