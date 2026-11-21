import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  requireAuth: vi.fn(),
  requireAuthContext: vi.fn(),
  query: {} as Record<string, any>,
}));

vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth, requireAuthContext: mocks.requireAuthContext }));

import { GET, POST } from '@/app/api/engagements/route';

function createEngagementRequest() {
  return new Request('http://localhost/api/engagements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      realm_id: 'realm-1', company_name: 'Example', audit_type: 'audit',
      start_date: '2026-01-01', end_date: '2026-12-31',
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.query, {
    select: vi.fn(() => mocks.query),
    eq: vi.fn(() => mocks.query),
    order: vi.fn(async () => ({ data: [{ id: 'e1', realm_id: 'realm-1' }], error: null })),
    insert: vi.fn(() => mocks.query),
    delete: vi.fn(() => mocks.query),
    update: vi.fn(() => mocks.query),
  });
  mocks.from.mockReturnValue(mocks.query);
});

describe('engagement routes', () => {
  it('lists only the authenticated realm and performs no mutations', async () => {
    mocks.requireAuthContext.mockResolvedValue({ supabase: { from: mocks.from }, user: { id: 'u1' }, realmId: 'realm-1' });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([{ id: 'e1', realm_id: 'realm-1' }]);
    expect(mocks.query.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
    expect(mocks.query.delete).not.toHaveBeenCalled();
    expect(mocks.query.update).not.toHaveBeenCalled();
  });

  it('rejects anonymous listing without querying engagements', async () => {
    mocks.requireAuthContext.mockRejectedValue(new Error('UNAUTHORIZED'));

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('rejects creation for a realm outside the authenticated account', async () => {
    mocks.requireAuthContext.mockResolvedValue({ supabase: { from: mocks.from }, user: { id: 'u1' }, realmId: 'realm-1' });
    const request = new Request('http://localhost/api/engagements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        realm_id: 'realm-2', company_name: 'Example', audit_type: 'audit',
        start_date: '2026-01-01', end_date: '2026-12-31',
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('creates an engagement without assigning unconfigured catalog requirements', async () => {
    const engagement = {
      id: 'new-engagement', realm_id: 'realm-1', company_name: 'Example', audit_type: 'audit',
      start_date: '2026-01-01', end_date: '2026-12-31', status: 'draft',
    };
    const existingDraftQuery: Record<string, any> = {
      select: vi.fn(() => existingDraftQuery),
      eq: vi.fn(() => existingDraftQuery),
      single: vi.fn(async () => ({ data: null, error: { code: 'PGRST116' } })),
    };
    const insertQuery: Record<string, any> = {
      insert: vi.fn(() => insertQuery),
      select: vi.fn(async () => ({ data: [engagement], error: null })),
    };
    mocks.requireAuthContext.mockResolvedValue({
      supabase: { from: mocks.from }, user: { id: 'u1' }, realmId: 'realm-1',
    });
    mocks.from.mockImplementation((table: string) => {
      expect(table).toBe('audit_engagements');
      return mocks.from.mock.calls.length === 1 ? existingDraftQuery : insertQuery;
    });

    const response = await POST(createEngagementRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(engagement);
    expect(insertQuery.insert).toHaveBeenCalledWith([expect.objectContaining({ realm_id: 'realm-1' })]);
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });
});
