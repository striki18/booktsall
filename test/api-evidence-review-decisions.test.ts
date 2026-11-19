import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ requireAuthContext: vi.fn(), from: vi.fn(), insertPayload: undefined as unknown }));
vi.mock('@/lib/auth', () => ({ requireAuthContext: mocks.requireAuthContext }));

import { GET, POST } from '@/app/api/evidence/register/[id]/decisions/route';

function query(result: any) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    insert: vi.fn((payload: unknown) => {
      mocks.insertPayload = payload;
      return builder;
    }),
    single: vi.fn(async () => result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

const params = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertPayload = undefined;
  mocks.requireAuthContext.mockResolvedValue({
    realmId: 'realm-owned',
    user: { id: 'user-1' },
    supabase: { from: mocks.from },
  });
  mocks.from.mockImplementation((table: string) => {
    if (table === 'qbo_evidence_register') return query({ data: { id: 'register-1', matched_document_id: 'doc-1', qbo_txn_id: 'txn-1' }, error: null });
    if (table === 'evidence_review_decisions') return query({ data: [{ id: 'decision-1' }], error: null });
    throw new Error(`Unexpected table ${table}`);
  });
});

describe('append-only evidence review decision API', () => {
  it('lists decisions filtered to the authenticated realm and register entry', async () => {
    const response = await GET(new NextRequest('http://localhost'), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.decisions).toHaveLength(1);
    const registerQuery = mocks.from.mock.results[0].value;
    const historyQuery = mocks.from.mock.results[1].value;
    expect(registerQuery.eq).toHaveBeenCalledWith('realm_id', 'realm-owned');
    expect(registerQuery.eq).toHaveBeenCalledWith('id', '11111111-1111-4111-8111-111111111111');
    expect(historyQuery.eq).toHaveBeenCalledWith('realm_id', 'realm-owned');
    expect(historyQuery.eq).toHaveBeenCalledWith('register_entry_id', '11111111-1111-4111-8111-111111111111');
  });

  it('appends a decision with the authenticated user and realm', async () => {
    const response = await POST(new NextRequest('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'assign_transaction', selectedQboTxnId: 'txn-2', rationale: 'Verified invoice number' }),
    }), params);

    expect(response.status).toBe(201);
    expect(mocks.insertPayload).toEqual({
      realm_id: 'realm-owned',
      register_entry_id: '11111111-1111-4111-8111-111111111111',
      evidence_document_id: 'doc-1',
      reviewer_user_id: 'user-1',
      action: 'assign_transaction',
      selected_qbo_txn_id: 'txn-2',
      rationale: 'Verified invoice number',
    });
  });

  it('requires a transaction target for manual assignment', async () => {
    const response = await POST(new NextRequest('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'assign_transaction' }),
    }), params);

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('denies anonymous access before database queries', async () => {
    mocks.requireAuthContext.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET(new NextRequest('http://localhost'), params);
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
