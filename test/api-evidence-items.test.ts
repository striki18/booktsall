import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from } }));

import { GET } from '@/app/api/evidence/items/route';

const realmId = '9341458707866620';
const additionalId = '11111111-1111-4111-8111-111111111111';
const registerId = '22222222-2222-4222-8222-222222222222';
const txnId = '500';

function query(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'range']) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve, reject);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'reviewer' }, realmId });
  mocks.from.mockImplementation((table: string) => {
    if (table === 'qbo_evidence_items') return query([{
      id: additionalId, realm_id: realmId, register_entry_id: registerId, proposed_register_entry_id: null,
      candidate_qbo_txn_ids: [txnId], source_type: 'client_upload', inbox_document_id: 'doc-1',
      qbo_attachable_id: null, content_sha256: 'a'.repeat(64), match_status: 'verified', review_status: 'required',
      evidence_role: 'additional', qbo_attachment_status: 'not_requested', duplicate_of_item_id: null, created_at: '2026-11-19T00:00:00Z',
    }, {
      id: '77777777-7777-4777-8777-777777777777', realm_id: realmId, register_entry_id: null, proposed_register_entry_id: null,
      candidate_qbo_txn_ids: [txnId], source_type: 'client_upload', inbox_document_id: 'doc-2',
      qbo_attachable_id: null, content_sha256: 'b'.repeat(64), match_status: 'potential', review_status: 'required',
      evidence_role: 'unassigned', qbo_attachment_status: 'not_requested', duplicate_of_item_id: null, created_at: '2026-11-19T00:00:00Z',
    }]);
    if (table === 'inbox_documents') return query([
      { id: 'doc-1', filename: 'receipt.pdf', content_type: 'application/pdf', file_size: 128 },
      { id: 'doc-2', filename: 'uncertain.pdf', content_type: 'application/pdf', file_size: 256 },
    ]);
    if (table === 'qbo_evidence_register') return query([{ id: registerId, qbo_txn_id: txnId, qbo_txn_type: 'Bill', qbo_txn_date: '2026-11-01', qbo_txn_vendor: 'Vendor', qbo_txn_amount: 12, qbo_txn_doc_number: 'INV-5' }]);
    throw new Error(`Unexpected table ${table}`);
  });
});

describe('evidence item review queue API', () => {
  it('returns company-scoped managed document identities including resolved evidence', async () => {
    const q = query([{ inbox_document_id: 'primary' }, { inbox_document_id: 'duplicate' }]);
    mocks.from.mockReturnValueOnce(q);
    const response = await GET(new Request('http://localhost/api/evidence/items?managedDocuments=true'));
    expect(await response.json()).toEqual({ documentIds: ['primary', 'duplicate'] });
    expect(q.eq).toHaveBeenCalledWith('realm_id', realmId);
    expect(q.eq).not.toHaveBeenCalledWith('review_status', 'required');
  });
  it('requires an authenticated company context', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('scopes item, document, and transaction reads to the authenticated realm', async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenNthCalledWith(1, 'qbo_evidence_items');
    expect(mocks.from).toHaveBeenCalledWith('inbox_documents');
    expect(mocks.from).toHaveBeenCalledWith('qbo_evidence_register');
    expect(body[0]).toMatchObject({ document: { filename: 'receipt.pdf' }, transactionChoices: [{ id: registerId, qbo_txn_id: txnId }] });
    expect(body.find((item: { match_status: string }) => item.match_status === 'potential')).toMatchObject({
      document: { filename: 'uncertain.pdf' }, transactionChoices: [{ id: registerId, qbo_txn_id: txnId }],
    });
  });

  it('returns potential items for confirmation and leaves unreviewed items out of the queue', async () => {
    mocks.from.mockImplementationOnce(() => query([{
      id: additionalId, match_status: 'potential', review_status: 'required', evidence_role: 'unassigned',
    }, {
      id: '88888888-8888-4888-8888-888888888888', match_status: 'unreviewed', review_status: 'required', evidence_role: 'unassigned',
    }]));
    const response = await GET();
    expect(await response.json()).toEqual([expect.objectContaining({ id: additionalId, match_status: 'potential' })]);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('reports database errors without returning cross-company data', async () => {
    mocks.from.mockImplementationOnce(() => query(null, { code: '42P01' }));
    const response = await GET();
    expect(response.status).toBe(503);
  });
});
