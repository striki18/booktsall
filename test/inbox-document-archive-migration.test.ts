import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261114001100_archive_inbox_documents_with_audit.sql', 'utf8');

describe('inbox document archive migration contract', () => {
  it('fails closed when the base inbox table is missing or archive objects conflict', () => {
    expect(sql).toContain("to_regclass('public.inbox_documents') IS NULL");
    expect(sql).toContain("to_regclass('public.inbox_document_events') IS NOT NULL");
    expect(sql).toContain('An existing inbox archive column has an incompatible type');
  });

  it('adds company-scoped immutable archive events without a cascading document foreign key', () => {
    expect(sql).toContain('CREATE TABLE public.inbox_document_events');
    expect(sql).toContain('UNIQUE (realm_id, document_id, event_type)');
    expect(sql).toContain('ALTER TABLE public.inbox_document_events ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')");
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.inbox_document_events');
    expect(sql).toContain('BEFORE TRUNCATE ON public.inbox_document_events');
    expect(sql).not.toMatch(/FOREIGN KEY\s*\([^)]*document_id[^)]*\)[\s\S]*?ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.inbox_documents/i);
  });

  it('archives metadata and inserts the audit event in the same database function', () => {
    expect(sql).toContain('CREATE FUNCTION public.archive_inbox_document');
    expect(sql).toContain('SET archived_at = now(), archived_by = p_actor_user_id');
    expect(sql).toContain('INSERT INTO public.inbox_document_events');
    expect(sql).toContain("RETURN 'already_archived'");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.archive_inbox_document(text,uuid,uuid,text) TO service_role');
  });
});
