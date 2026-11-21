import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261113000100_add_company_scoped_rls.sql'),
  'utf8',
);

describe('company-scoped RLS migration contract', () => {
  it.each([
    'generated_evidence_packages',
    'quickbooks_tokens',
    'audit_engagements',
    'audit_evidence_catalog',
    'audit_evidence_plan',
    'evidence_history',
    'evidence_requests',
    'evidence_documents',
    'evidence_packages',
    'evidence_package_items',
    'company_inboxes',
    'collection_requests',
    'inbox_documents',
    'qbo_evidence_register',
  ])('enables RLS on %s', (table) => {
    expect(migration).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
  });

  it('keeps QuickBooks token secrets without an authenticated table policy', () => {
    expect(migration).toContain('ALTER TABLE public.quickbooks_tokens ENABLE ROW LEVEL SECURITY;');
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*?ON public\.quickbooks_tokens/i);
  });

  it('uses the server-controlled app_metadata realm claim for tenant checks', () => {
    expect(migration).toContain("auth.jwt() -> 'app_metadata' ->> 'realm_id'");
    expect(migration).not.toMatch(/auth\.jwt\(\)\s*->\s*'user_metadata'/i);
  });

  it('covers all repository-defined evidence object path families', () => {
    expect(migration).toContain("(storage.foldername(name))[1] = 'inbox'");
    expect(migration).toContain('public.audit_engagements e');
    expect(migration).toContain("(storage.foldername(name))[1] = 'evidence'");
    expect(migration).toContain("split_part(name, '/', 2) = p.id::text || '.zip'");
    expect(migration).toContain("bucket_id = 'evidence'");
    expect(migration).toMatch(/CREATE POLICY evidence_objects_company_scope ON storage\.objects\s+FOR SELECT TO authenticated/i);
    expect(migration).not.toMatch(/CREATE POLICY evidence_objects_company_scope ON storage\.objects\s+FOR (ALL|INSERT|UPDATE|DELETE) TO authenticated/i);
  });
});
describe('generated package migration contract', () => {
  const packageSchema = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261113000000_create_generated_evidence_packages.sql'),
    'utf8',
  );

  it('persists immutable package metadata with realm and date constraints', () => {
    expect(packageSchema).toContain('CREATE TABLE IF NOT EXISTS public.generated_evidence_packages');
    expect(packageSchema).toContain('realm_id text NOT NULL');
    expect(packageSchema).toContain('zip_path text NOT NULL UNIQUE');
    expect(packageSchema).toContain("status IN ('complete', 'partial')");
    expect(packageSchema).toContain('start_date <= end_date');
    expect(packageSchema).toContain('(realm_id, created_at DESC)');
  });

  it('scopes generated package rows and objects to the JWT realm', () => {
    expect(migration).toContain('generated_evidence_packages_company_scope');
    expect(migration).toContain("(storage.foldername(name))[1] = 'packages'");
    expect(migration).toMatch(/\(storage\.foldername\(name\)\)\[2\] = \(auth\.jwt\(\) -> 'app_metadata' ->> 'realm_id'\)/);
  });
});

describe('shared package run migration contract', () => {
  const packageRunSchema = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261114000200_unify_evidence_package_runs.sql'),
    'utf8',
  );

  it('preserves existing QBO rows and adds engagement, immutable version, and status metadata', () => {
    expect(packageRunSchema).toContain("ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'qbo_period'");
    expect(packageRunSchema).toContain('ADD COLUMN IF NOT EXISTS engagement_id uuid');
    expect(packageRunSchema).toContain('ADD COLUMN IF NOT EXISTS package_version integer NOT NULL DEFAULT 1');
    expect(packageRunSchema).toContain('ADD COLUMN IF NOT EXISTS previous_package_id uuid');
    expect(packageRunSchema).toContain("('generating', 'complete', 'partial', 'failed')");
    expect(packageRunSchema).toContain('ADD COLUMN IF NOT EXISTS generated_package_id uuid');
    expect(packageRunSchema).toContain('row_number() OVER (PARTITION BY realm_id, start_date, end_date');
    expect(packageRunSchema).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_evidence_packages_qbo_version');
    expect(packageRunSchema).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_evidence_packages_engagement_version');
    expect(packageRunSchema).toContain('ALTER COLUMN zip_path DROP NOT NULL');
  });
});
describe('append-only evidence review decision migration contract', () => {
  const decisionsSchema = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261114000000_create_evidence_review_decisions.sql'),
    'utf8',
  );

  it('stores company and reviewer attribution while preserving register history', () => {
    expect(decisionsSchema).toContain('realm_id text NOT NULL');
    expect(decisionsSchema).toContain('register_entry_id uuid NOT NULL');
    expect(decisionsSchema).toContain('evidence_document_id uuid REFERENCES public.inbox_documents(id) ON DELETE RESTRICT');
    expect(decisionsSchema).toContain('reviewer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(decisionsSchema).toContain('created_at timestamptz NOT NULL DEFAULT now()');
  });

  it('allows company-scoped reads and inserts, with no authenticated update/delete policy', () => {
    expect(decisionsSchema).toContain('FOR SELECT TO authenticated');
    expect(decisionsSchema).toContain('FOR INSERT TO authenticated');
    expect(decisionsSchema).toContain("auth.jwt() -> 'app_metadata' ->> 'realm_id'");
    expect(decisionsSchema).toContain('reviewer_user_id = auth.uid()');
    expect(decisionsSchema).toContain('r.realm_id = evidence_review_decisions.realm_id');
    expect(decisionsSchema).toContain('d.realm_id = evidence_review_decisions.realm_id');
    expect(decisionsSchema).not.toMatch(/FOR (UPDATE|DELETE|ALL) TO authenticated/i);
    expect(decisionsSchema).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.evidence_review_decisions FROM authenticated');
  });
});

describe('QuickBooks company membership migration contract', () => {
  const membershipSchema = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261114000300_add_qbo_company_memberships.sql'),
    'utf8',
  );

  it('preserves existing server-bound companies as user memberships', () => {
    expect(membershipSchema).toContain('CREATE TABLE IF NOT EXISTS public.qbo_company_memberships');
    expect(membershipSchema).toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(membershipSchema).toContain('UNIQUE (user_id, realm_id)');
    expect(membershipSchema).toContain("raw_app_meta_data ->> 'realm_id'");
    expect(membershipSchema).toContain('ON CONFLICT (user_id, realm_id) DO NOTHING');
  });

  it('allows users to read only their memberships and reserves writes to service role', () => {
    expect(membershipSchema).toContain('ENABLE ROW LEVEL SECURITY');
    expect(membershipSchema).toContain('USING (user_id = (SELECT auth.uid()))');
    expect(membershipSchema).toContain('GRANT SELECT ON TABLE public.qbo_company_memberships TO authenticated');
    expect(membershipSchema).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.qbo_company_memberships FROM authenticated');
    expect(membershipSchema).toContain('GRANT ALL ON TABLE public.qbo_company_memberships TO service_role');
  });
});

describe('server-only inbox and register writes migration contract', () => {
  const writeScope = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261114001200_reserve_evidence_writes_for_server.sql'),
    'utf8',
  );

  it.each(['inbox_documents', 'qbo_evidence_register'])('replaces the %s ALL policy with realm-scoped SELECT', (table) => {
    expect(writeScope).toContain(`DROP POLICY IF EXISTS ${table}_company_scope ON public.${table};`);
    expect(writeScope).toMatch(new RegExp(`CREATE POLICY ${table}_company_scope ON public\\.${table}\\s+FOR SELECT TO authenticated`));
    expect(writeScope).toContain("realm_id = (SELECT auth.jwt() -> 'app_metadata' ->> 'realm_id')");
    expect(writeScope).not.toMatch(/CREATE POLICY[^;]*\bFOR (ALL|INSERT|UPDATE|DELETE)\b/i);
  });

  it('revokes direct client privileges and fails atomically if effective writes remain', () => {
    expect(writeScope).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
    expect(writeScope).toMatch(/REVOKE ALL PRIVILEGES ON TABLE public\.inbox_documents, public\.qbo_evidence_register\s+FROM PUBLIC, anon, authenticated;/);
    expect(writeScope).toContain('GRANT SELECT ON TABLE public.inbox_documents, public.qbo_evidence_register TO authenticated;');
    expect(writeScope).toContain("has_any_column_privilege(client_role, evidence_table, 'INSERT, UPDATE, REFERENCES')");
    expect(writeScope).toContain("has_table_privilege(client_role, evidence_table, 'DELETE, TRUNCATE, TRIGGER')");
    expect(writeScope).toContain("RAISE EXCEPTION 'Unexpected write privileges remain");
    expect(writeScope).toContain("RAISE EXCEPTION 'Required server privileges are missing");
    expect(writeScope).toContain("RAISE EXCEPTION 'Unexpected permissive read policy");
  });
});
