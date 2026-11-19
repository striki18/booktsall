import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock('../lib/document-extraction', () => ({
  matchDocumentToTransactions: vi.fn(), extractFieldsFromText: vi.fn(),
  getCollectionRequestWithTransactions: vi.fn(), downloadDocument: vi.fn(), getClaimedTransactionIds: vi.fn(),
}));
vi.mock('../lib/quickbooks', () => ({ getAttachables: vi.fn(), normalizeAttachables: vi.fn(), getTransactions: vi.fn(), normalizeTransactionList: vi.fn() }));

import { analyzeQboSide, findInboxDocumentForAttachable, persistRegisterEntries, resolveStateConflicts, type RegisterEntry } from '../lib/qbo-evidence-register';

function entry(id: string, documentId: string, transactionId: string): RegisterEntry {
  return {
    id, realmId: 'realm-1', collectionRequestId: null,
    qboTxnId: transactionId, qboTxnType: 'Bill', qboTxnDate: '2026-10-01',
    qboTxnVendor: 'Acme', qboTxnAmount: 10, qboTxnDocNumber: id,
    attachableId: null, attachmentFilename: `${id}.pdf`, attachmentFileSize: 10,
    attachmentDownloadUrl: null, registerState: 'MATCHED', matchedDocumentId: documentId,
    matchConfidence: 100, matchFieldDetails: null, correctQboTxnId: null, reviewCandidateTxnIds: [],
  };
}

describe('register evidence association preservation', () => {
  it('keeps a second document association as review when the transaction is already matched', () => {
    const result = resolveStateConflicts([entry('r1', 'doc-1', 'txn-1'), entry('r2', 'doc-2', 'txn-1')]);
    expect(result.filter((row) => row.registerState === 'MATCHED')).toHaveLength(1);
    const review = result.find((row) => row.id === 'r2')!;
    expect(review.registerState).toBe('REVIEW_REQUIRED');
    expect(review.qboTxnId).toBeNull();
    expect(review.matchedDocumentId).toBe('doc-2');
    expect(review.reviewCandidateTxnIds).toContain('txn-1');
  });

  it('persists additional evidence as a document-side review row without overwriting the transaction row', async () => {
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    }));
    const primary = entry('r1', 'doc-1', 'txn-1');
    const additional = entry('r2', 'doc-2', 'txn-1');
    additional.registerState = 'REVIEW_REQUIRED'; additional.qboTxnId = null;
    additional.reviewCandidateTxnIds = ['txn-1'];
    await persistRegisterEntries([primary, additional], 'realm-1');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const insertPayload = mocks.from.mock.results[1].value.insert.mock.calls[0][0];
    expect(insertPayload.qbo_txn_id).toBeNull();
    expect(insertPayload.matched_document_id).toBe('doc-2');
    expect(insertPayload.register_state).toBe('REVIEW_REQUIRED');
    expect(insertPayload.review_candidate_txn_ids).toEqual(['txn-1']);
  });

  it('associates QBO evidence by a unique transaction relationship, not by filename', () => {
    const doc = { id: 'doc-1', filename: 'identical.pdf', matched_transaction_id: 'txn-1' };
    expect(findInboxDocumentForAttachable({ fileName: 'other.pdf', entityId: 'txn-1' }, [doc])).toBe(doc);
    expect(findInboxDocumentForAttachable({ fileName: 'identical.pdf', entityId: 'txn-2' }, [doc])).toBeNull();
    expect(findInboxDocumentForAttachable({ fileName: 'identical.pdf', entityId: 'txn-1' }, [doc, { ...doc, id: 'doc-2' }])).toBeNull();
  });
  it('keeps orphaned QBO attachables visible as review rows without inventing a transaction', async () => {
    const entries = await analyzeQboSide(
      [],
      [{ attachableId: 'orphan-1', entityId: null, fileName: 'orphan.pdf', fileSize: 10, downloadUrl: null }],
      [],
      new Map(),
      new Map(),
      undefined,
      'realm-1',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      qboTxnId: null,
      attachableId: 'orphan-1',
      attachmentFilename: 'orphan.pdf',
      registerState: 'REVIEW_REQUIRED',
      matchedDocumentId: null,
    });
  });
});
