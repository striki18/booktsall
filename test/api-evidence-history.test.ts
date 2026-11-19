import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuthContext: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuthContext: mocks.requireAuthContext }));

import { GET } from '@/app/api/evidence/history/route';

function queryFor(data: unknown) {
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockImplementation((table: string) => {
    if (table === 'audit_engagements') return queryFor([{ id: 'eng-1' }]);
    if (table === 'evidence_packages') return queryFor([{ id: 'legacy', engagement_id: 'eng-1', created_at: '2026-01-01T00:00:00Z' }]);
    if (table === 'generated_evidence_packages') return queryFor([{ id: 'generated', realm_id: 'realm-1', source_type: 'qbo_period', created_at: '2026-01-02T00:00:00Z' }]);
    throw new Error(`Unexpected table ${table}`);
  });
  mocks.requireAuthContext.mockResolvedValue({ realmId: 'realm-1', supabase: { from: mocks.from } });
});

describe('evidence package history', () => {
  it('combines generated packages and engagement packages newest first with company scoping', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.map((row: { id: string }) => row.id)).toEqual(['generated', 'legacy']);
    expect(body[0].source_type).toBe('qbo_period');
    expect(body[1].source_type).toBe('legacy_engagement');
    expect(mocks.from).toHaveBeenCalledWith('generated_evidence_packages');
    expect(mocks.from.mock.results[1].value.is).toHaveBeenCalledWith('generated_package_id', null);
    const generatedQuery = mocks.from.mock.results[2].value;
    expect(generatedQuery.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
  });

  it('rejects unauthenticated history requests before database access', async () => {
    mocks.requireAuthContext.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
