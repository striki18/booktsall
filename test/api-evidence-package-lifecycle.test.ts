import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireOwnedEngagement: vi.fn(), createPackageRun: vi.fn(), from: vi.fn(), filters: [] as Array<{ table: string; column: string; value: unknown }>, inserted: [] as Array<{ table: string; rows: unknown }> }));
vi.mock('@/lib/resource-access', () => ({
  requireOwnedEngagement: mocks.requireOwnedEngagement,
  ownershipErrorStatus: (error: Error) => error.message === 'UNAUTHORIZED' ? 401 : error.message === 'FORBIDDEN' ? 403 : null,
}));
vi.mock('@/lib/package-runs', () => ({ createPackageRun: mocks.createPackageRun }));

import { POST } from '@/app/api/evidence/package/route';

function queryFor(table: string) {
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.is = vi.fn((column: string, value: unknown) => { mocks.filters.push({ table, column, value }); return query; });
  query.single = vi.fn(async () => table === 'audit_engagements'
    ? { data: { id: 'engagement-1' }, error: null }
    : { data: { id: 'package-run-1' }, error: null });
  query.insert = vi.fn((rows: unknown) => { mocks.inserted.push({ table, rows }); return query; });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({
    data: table === 'evidence_requests'
      ? [{ id: 'request-1', audit_evidence_plan: { audit_evidence_catalog: { evidence_name: 'Invoices' } } }]
      : table === 'evidence_documents'
        ? [{ id: 'document-1', evidence_request_id: 'request-1', filename: 'invoice.pdf', storage_path: 'engagement/request/invoice.pdf' }]
        : null,
    error: null,
  }).then(resolve);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted.length = 0;
  mocks.filters.length = 0;
  mocks.requireOwnedEngagement.mockResolvedValue({
    supabase: { from: mocks.from },
    realmId: 'realm-1',
    user: { id: 'user-1' },
  });
  mocks.from.mockImplementation((table: string) => queryFor(table));
  mocks.createPackageRun.mockResolvedValue({ id: 'package-run-1', package_version: 2, previous_package_id: 'older-run' });
});

describe('engagement package run creation', () => {
  it('creates a versioned canonical run and retains a document-item snapshot', async () => {
    const response = await POST(new Request('http://localhost/api/evidence/package', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engagementId: '123e4567-e89b-42d3-a456-426614174000' }),
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ status: 'generating', documentCount: 1, packageVersion: 2, previousPackageId: 'older-run' });
    expect(mocks.createPackageRun).toHaveBeenCalledWith(expect.objectContaining({
      realmId: 'realm-1', createdBy: 'user-1', sourceType: 'engagement',
      filename: expect.stringContaining('EvidencePackage_'),
    }));
    expect(mocks.inserted).toContainEqual({ table: 'evidence_packages', rows: expect.objectContaining({
      id: 'package-run-1', generated_package_id: 'package-run-1', engagement_id: '123e4567-e89b-42d3-a456-426614174000',
    }) });
    expect(mocks.inserted).toContainEqual({ table: 'evidence_package_items', rows: [expect.objectContaining({
      package_id: 'package-run-1', document_id: 'document-1', folder_name: 'Invoices', storage_path: 'engagement/request/invoice.pdf',
    })] });
    expect(mocks.filters).toContainEqual({ table: 'evidence_documents', column: 'archived_at', value: null });
    expect(mocks.from).not.toHaveBeenCalledWith('qbo_evidence_register');
    expect(mocks.from).not.toHaveBeenCalledWith('evidence_review_decisions');
  });
});
