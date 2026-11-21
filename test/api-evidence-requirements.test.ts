import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST, GET } from '@/app/api/evidence/requirements/route';
import { GET as evaluateRequirements } from '@/app/api/evidence/requirements/evaluate/route';

const mocks = vi.hoisted(() => ({ requireAuthContext: vi.fn(), from: vi.fn(), insertPayload: undefined as unknown }));
vi.mock('@/lib/auth', () => ({ requireAuthContext: mocks.requireAuthContext }));

function makeQuery() {
  const result = { data: [{ id: 'rule-1', transaction_type: 'Invoice', document_type: 'invoice' }], error: null };
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.insert = vi.fn((payload: unknown) => { mocks.insertPayload = payload; return builder; });
  builder.single = vi.fn(async () => ({ data: result.data[0], error: null }));
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertPayload = undefined;
  mocks.requireAuthContext.mockResolvedValue({ realmId: 'realm-owned', user: { id: 'user-1' }, supabase: { from: mocks.from } });
  mocks.from.mockReturnValue(makeQuery());
});

describe('company evidence requirement rules API', () => {
  it('lists rules only for the authenticated company', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(mocks.from).toHaveBeenCalledWith('evidence_requirement_rules');
    expect(mocks.from.mock.results[0].value.eq).toHaveBeenCalledWith('realm_id', 'realm-owned');
  });

  it('creates only a user-specified rule and derives company and creator from auth', async () => {
    const response = await POST(new Request('http://localhost/api/evidence/requirements', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Large invoice support', transaction_type: 'Invoice', amount_min: 500, amount_max: 900, document_type: 'Invoice' }),
    }));

    expect(response.status).toBe(201);
    expect(mocks.insertPayload).toEqual({
      realm_id: 'realm-owned', created_by: 'user-1', name: 'Large invoice support',
      transaction_type: 'Invoice', amount_min: 500, amount_max: 900, document_type: 'invoice', is_active: true,
    });
  });

  it('rejects an inverted range without writing', async () => {
    const response = await POST(new Request('http://localhost/api/evidence/requirements', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid', transaction_type: 'Invoice', amount_min: 900, amount_max: 500, document_type: 'invoice' }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.insertPayload).toBeUndefined();
  });

  it('denies anonymous requests before database access', async () => {
    mocks.requireAuthContext.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('rejects impossible calendar dates before querying the database', async () => {
    const response = await evaluateRequirements(new Request('http://localhost/api/evidence/requirements/evaluate?startDate=2026-02-30&endDate=2026-03-01'));
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
