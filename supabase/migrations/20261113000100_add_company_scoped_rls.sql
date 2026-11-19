-- Company-scoped access policies for the current single-realm-per-user application model.
-- Company membership is taken only from the server-controlled app_metadata JWT claim.
-- This migration describes the repository schema; inspect the target database and
-- migration history before applying it anywhere.

-- Token secrets remain available only through trusted service-role server code.
ALTER TABLE public.quickbooks_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_evidence_packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS generated_evidence_packages_company_scope ON public.generated_evidence_packages;
CREATE POLICY generated_evidence_packages_company_scope ON public.generated_evidence_packages
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));


ALTER TABLE public.audit_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_evidence_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_evidence_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_package_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_evidence_register ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_engagements_company_scope ON public.audit_engagements;
CREATE POLICY audit_engagements_company_scope ON public.audit_engagements
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS audit_evidence_catalog_authenticated_read ON public.audit_evidence_catalog;
CREATE POLICY audit_evidence_catalog_authenticated_read ON public.audit_evidence_catalog
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS audit_evidence_plan_company_scope ON public.audit_evidence_plan;
CREATE POLICY audit_evidence_plan_company_scope ON public.audit_evidence_plan
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audit_engagements e
    WHERE e.id = audit_evidence_plan.engagement_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audit_engagements e
    WHERE e.id = audit_evidence_plan.engagement_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ));

DROP POLICY IF EXISTS evidence_history_company_scope ON public.evidence_history;
CREATE POLICY evidence_history_company_scope ON public.evidence_history
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS evidence_requests_company_scope ON public.evidence_requests;
CREATE POLICY evidence_requests_company_scope ON public.evidence_requests
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audit_engagements e
    WHERE e.id = evidence_requests.engagement_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audit_engagements e
    WHERE e.id = evidence_requests.engagement_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ));

DROP POLICY IF EXISTS evidence_documents_company_scope ON public.evidence_documents;
CREATE POLICY evidence_documents_company_scope ON public.evidence_documents
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.evidence_requests r
    JOIN public.audit_engagements e ON e.id = r.engagement_id
    WHERE r.id = evidence_documents.evidence_request_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.evidence_requests r
    JOIN public.audit_engagements e ON e.id = r.engagement_id
    WHERE r.id = evidence_documents.evidence_request_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ));

DROP POLICY IF EXISTS evidence_packages_company_scope ON public.evidence_packages;
CREATE POLICY evidence_packages_company_scope ON public.evidence_packages
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audit_engagements e
    WHERE e.id = evidence_packages.engagement_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audit_engagements e
    WHERE e.id = evidence_packages.engagement_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ));

DROP POLICY IF EXISTS evidence_package_items_company_scope ON public.evidence_package_items;
CREATE POLICY evidence_package_items_company_scope ON public.evidence_package_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.evidence_packages p
    JOIN public.audit_engagements e ON e.id = p.engagement_id
    WHERE p.id = evidence_package_items.package_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.evidence_packages p
    JOIN public.audit_engagements e ON e.id = p.engagement_id
    WHERE p.id = evidence_package_items.package_id
      AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ));

DROP POLICY IF EXISTS company_inboxes_company_scope ON public.company_inboxes;
CREATE POLICY company_inboxes_company_scope ON public.company_inboxes
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS collection_requests_company_scope ON public.collection_requests;
CREATE POLICY collection_requests_company_scope ON public.collection_requests
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS inbox_documents_company_scope ON public.inbox_documents;
CREATE POLICY inbox_documents_company_scope ON public.inbox_documents
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS qbo_evidence_register_company_scope ON public.qbo_evidence_register;
CREATE POLICY qbo_evidence_register_company_scope ON public.qbo_evidence_register
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

-- Evidence objects use one bucket and four repository-defined path formats:
-- inbox/{realm}/{token-or-document-id}/{filename}
-- {engagement-id}/{request-id}/{filename}
-- evidence/{package-id}.zip
-- packages/{realm}/{generated-package-id}/{filename}
-- The server uses service-role Storage operations. Authenticated clients may read
-- only their company's evidence paths; direct uploads, replacements, and deletes
-- are intentionally unavailable to authenticated clients.
DROP POLICY IF EXISTS evidence_objects_company_scope ON storage.objects;
CREATE POLICY evidence_objects_company_scope ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'evidence'
    AND (
      (
        (storage.foldername(name))[1] = 'inbox'
        AND (storage.foldername(name))[2] = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
      )
      OR EXISTS (
        SELECT 1 FROM public.audit_engagements e
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
      )
      OR (
        (storage.foldername(name))[1] = 'packages'
        AND (storage.foldername(name))[2] = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
      )
      OR EXISTS (
        SELECT 1
        FROM public.evidence_packages p
        JOIN public.audit_engagements e ON e.id = p.engagement_id
        WHERE (storage.foldername(name))[1] = 'evidence'
          AND split_part(name, '/', 2) = p.id::text || '.zip'
          AND e.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
      )
    )
  );
