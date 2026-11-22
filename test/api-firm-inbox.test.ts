import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));

import { GET, PATCH, POST } from '@/app/api/firm/inbox/route';

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

describe('firm inbox API authorization', () => {
  it('does not query Supabase for anonymous users', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));

    const result = await GET();

    expect(result.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the first candidate transaction when no proposed register entry was stored', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any)
      .mockResolvedValueOnce(response([{ id: 'i1', realm_id: 'realm-1', token: 'token' }]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{ id: 'd1', realm_id: 'realm-1', filename: 'receipt.pdf' }]))
      .mockResolvedValueOnce(response([{ inbox_document_id: 'd1', register_entry_id: null, proposed_register_entry_id: null, candidate_qbo_txn_ids: ['txn-9'], match_status: 'potential', review_status: 'required', evidence_role: 'unassigned' }]))
      .mockResolvedValueOnce(response([{ id: 'entry-9', qbo_txn_id: 'txn-9', qbo_txn_type: 'Invoice', qbo_txn_date: '2026-10-16', qbo_txn_vendor: 'Amy', qbo_txn_amount: 108, qbo_txn_doc_number: '1001' }]));
    const body = await (await GET()).json();
    expect(body.documents[0].proposed_transaction).toMatchObject({ qboTxnId: 'txn-9', documentNumber: '1001' });
  });

  it('scopes all reads to the authenticated realm', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any)
      .mockResolvedValueOnce(response([{ id: 'i1', realm_id: 'realm-1', token: 'secret-link-token' }]))
      .mockResolvedValueOnce(response([{ id: 'r1', realm_id: 'realm-1', transaction_ids: [] }]))
      .mockResolvedValueOnce(response([{ id: 'd1', realm_id: 'realm-1', filename: 'receipt.pdf' }]))
      .mockResolvedValueOnce(response([{ inbox_document_id: 'd1', register_entry_id: null, proposed_register_entry_id: 'entry-1', candidate_qbo_txn_ids: ['txn-1'], match_status: 'duplicate', review_status: 'required', evidence_role: 'unassigned', match_confidence: 91, match_evidence: { amount_match: true } }]))
      .mockResolvedValueOnce(response([{ id: 'entry-1', qbo_txn_id: 'txn-1', qbo_txn_type: 'Invoice', qbo_txn_date: '2026-11-01', qbo_txn_vendor: 'Example customer', qbo_txn_amount: 125, qbo_txn_doc_number: '1001' }]));

    const result = await GET();
    const body = await result.json();

    expect(result.status).toBe(200);
    expect(body.inbox.realm_id).toBe('realm-1');
    expect(body.documents[0]).toMatchObject({
      evidence_match_status: 'duplicate',
      evidence_review_status: 'required',
      evidence_role: 'unassigned',
      evidence_match_confidence: 91,
      proposed_transaction: expect.objectContaining({ qboTxnId: 'txn-1', documentNumber: '1001' }),
    });
    expect((fetch as any).mock.calls).toHaveLength(5);
    for (const [url] of (fetch as any).mock.calls) {
      expect(String(url)).toContain('realm_id=eq.realm-1');
    }
  });

  it('rejects a caller-supplied realm different from the authenticated one', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    const request = new Request('http://localhost/api/firm/inbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ realm_id: 'realm-2', transaction_ids: ['txn-1'] }),
    });

    const result = await POST(request as any);

    expect(result.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('generates a high-entropy token for a new inbox', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any)
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{ id: 'i1', realm_id: 'realm-1', token: 'x'.repeat(43) }]))
      .mockResolvedValueOnce(response([{ id: 'r1', realm_id: 'realm-1', transaction_ids: ['txn-1'] }]));
    const request = new Request('http://localhost/api/firm/inbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ realm_id: 'realm-1', transaction_ids: ['txn-1'] }),
    });

    const result = await POST(request as any);
    const body = await result.json();

    expect(result.status).toBe(201);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((fetch as any).mock.calls).toHaveLength(3);
    const createBody = JSON.parse((fetch as any).mock.calls[1][1].body);
    expect(createBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
describe('firm inbox token rotation', () => {
  it('rotates only the authenticated realm token', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any).mockResolvedValueOnce(response([{ id: 'inbox-1', realm_id: 'realm-1', token: 'rotated-token', created_at: '2026-01-01' }]));

    const result = await PATCH();
    const body = await result.json();
    const [url, options] = (fetch as any).mock.calls[0];

    expect(result.status).toBe(200);
    expect(body.inbox.token).toBe('rotated-token');
    expect(String(url)).toContain('realm_id=eq.realm-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not rotate a token for anonymous callers', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));

    const result = await PATCH();

    expect(result.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
