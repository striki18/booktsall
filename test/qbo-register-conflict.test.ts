import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock('../lib/document-extraction', () => ({
  matchDocumentToTransactions: vi.fn(), extractFieldsFromText: vi.fn(),
  getCollectionRequestWithTransactions: vi.fn(), downloadDocument: vi.fn(), getClaimedTransactionIds: vi.fn(),
}));
vi.mock('../lib/quickbooks', () => ({ downloadAttachableBytes: vi.fn(), getAttachables: vi.fn(), normalizeAttachables: vi.fn(), getTransactions: vi.fn(), normalizeTransactionList: vi.fn() }));

import { analyzeQboSide, bindQboAttachmentIdentities, buildQboEvidenceRegister, findInboxDocumentForAttachable, persistRegisterEntries, resolveStateConflicts, updateRegisterForDocument, type RegisterEntry } from '../lib/qbo-evidence-register';
import { downloadAttachableBytes } from '../lib/quickbooks';
import { createHash } from 'node:crypto';
import { getClaimedTransactionIds, downloadDocument, matchDocumentToTransactions } from '../lib/document-extraction';

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
  beforeEach(() => vi.clearAllMocks());
  it('does not re-extract or rematch archived documents when rebuilding the register', async () => {
    let activeOnly = false;
    const query: Record<string, any> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.is = vi.fn((column: string, value: unknown) => { activeOnly = column === 'archived_at' && value === null; return query; });
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: activeOnly ? [] : [{ id: 'archived-doc', archived_at: '2026-11-01', storage_path: 'retained/file.pdf' }], error: null }).then(resolve);
    mocks.from.mockReturnValue(query);
    vi.mocked(getClaimedTransactionIds).mockResolvedValue(new Set());
    vi.mocked(downloadDocument).mockClear();
    vi.mocked(matchDocumentToTransactions).mockClear();
    expect(await buildQboEvidenceRegister({ realmId: 'realm-1', transactions: [], attachables: [] })).toEqual([]);
    expect(downloadDocument).not.toHaveBeenCalled();
    expect(matchDocumentToTransactions).not.toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
  });
  it('keeps a second document association as review when the transaction is already matched', () => {
    const result = resolveStateConflicts([entry('r1', 'doc-1', 'txn-1'), entry('r2', 'doc-2', 'txn-1')]);
    expect(result.filter((row) => row.registerState === 'MATCHED')).toHaveLength(1);
    const review = result.find((row) => row.id === 'r2')!;
    expect(review.registerState).toBe('REVIEW_REQUIRED');
    expect(review.qboTxnId).toBeNull();
    expect(review.matchedDocumentId).toBe('doc-2');
    expect(review.reviewCandidateTxnIds).toContain('txn-1');
  });

  it('preserves a proven wrong attachment beside correct primary evidence on the same transaction', () => {
    const primary = entry('primary', 'correct-doc', 'txn-1');
    const wrong = { ...entry('wrong', 'wrong-doc', 'txn-1'), registerState: 'WRONG_MATCHED' as const, correctQboTxnId: 'txn-2' };
    const result = resolveStateConflicts([primary, wrong]);
    expect(result[0]).toMatchObject({ registerState: 'MATCHED', qboTxnId: 'txn-1', matchedDocumentId: 'correct-doc' });
    expect(result[1]).toMatchObject({ registerState: 'WRONG_MATCHED', qboTxnId: null, attachedQboTxnId: 'txn-1', correctQboTxnId: 'txn-2', reviewCandidateTxnIds: ['txn-1'] });
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

  it('does not replace the transaction register when a certain additional document matches it', async () => {
    mocks.rpc.mockClear();
    mocks.from.mockReset();
    const primary = entry('r1', 'doc-1', 'txn-1');
    const databasePrimary = {
      id: primary.id, realm_id: primary.realmId, collection_request_id: 'older-request',
      qbo_txn_id: primary.qboTxnId, qbo_txn_type: primary.qboTxnType, qbo_txn_date: primary.qboTxnDate,
      qbo_txn_vendor: primary.qboTxnVendor, qbo_txn_amount: primary.qboTxnAmount,
      qbo_txn_doc_number: primary.qboTxnDocNumber, attachable_id: primary.attachableId,
      attachment_filename: primary.attachmentFilename, attachment_file_size: primary.attachmentFileSize,
      attachment_download_url: primary.attachmentDownloadUrl, register_state: primary.registerState,
      matched_document_id: primary.matchedDocumentId, match_confidence: primary.matchConfidence,
      match_field_details: primary.matchFieldDetails, correct_qbo_txn_id: primary.correctQboTxnId,
      review_candidate_txn_ids: primary.reviewCandidateTxnIds,
    };
    const entriesQuery = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [databasePrimary], error: null }).then(resolve),
    };
    const missingQuery = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mocks.from.mockImplementationOnce(() => entriesQuery).mockImplementationOnce(() => missingQuery);

    const result = await updateRegisterForDocument(
      'doc-2', 'realm-1', 'newer-request',
      { documentId: 'doc-2', transactionId: 'txn-1', confidence: 100, status: 'matched',
        matchSignals: { vendorMatch: true, amountMatch: true, dateMatch: true, documentNumberMatch: true },
        matchedTransaction: { txnId: 'txn-1', txnType: 'Bill', date: '2026-10-01', vendor: 'Acme', amount: 10, docNumber: 'INV-1' } } as never,
      { vendorName: 'Acme', documentDate: '2026-10-01', totalAmount: 10, documentNumber: 'INV-1', documentType: 'invoice', rawText: '' },
    );

    expect(result).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(missingQuery.maybeSingle).toHaveBeenCalledOnce();
  });

  it('requires actual attachment identity rather than a filename or shared transaction', () => {
    const doc = { id: 'doc-1', filename: 'identical.pdf', matched_transaction_id: 'txn-1' };
    expect(findInboxDocumentForAttachable({ attachableId: 'att-1', fileName: 'identical.pdf', entityId: 'txn-1' }, [doc])).toBeNull();
    const proven = { ...doc, verified_qbo_attachable_ids: ['att-1'] };
    expect(findInboxDocumentForAttachable({ attachableId: 'att-1', fileName: 'other.pdf', entityId: 'other-txn' }, [proven])).toBe(proven);
    expect(findInboxDocumentForAttachable({ fileName: 'identical.pdf', entityId: 'txn-2' }, [doc])).toBeNull();
    expect(findInboxDocumentForAttachable({ attachableId: 'att-1' }, [proven, { ...proven, id: 'doc-2' }])).toBeNull();
  });

  it.each([true, false])('binds an unfamiliar QBO ID only when downloaded file bytes match: %s', async (sameBytes) => {
    const bytes = Buffer.from('actual source PDF');
    const query: Record<string, any> = {};
    for (const method of ['select', 'eq', 'order', 'range']) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ inbox_document_id: 'doc-A', qbo_attachable_id: 'old-id', qbo_attachment_status: 'verified', content_sha256: createHash('sha256').update(bytes).digest('hex'), evidence_role: 'primary', review_status: 'not_required' }], error: null }).then(resolve);
    mocks.from.mockReturnValue(query);
    vi.mocked(downloadAttachableBytes).mockResolvedValue({ bytes: sameBytes ? bytes : Buffer.from('other file'), httpStatus: 200 });
    const docs = [{ id: 'doc-A', matched_transaction_id: 'txn-A' }, { id: 'doc-B', matched_transaction_id: 'txn-B' }];
    const attachment = { attachableId: 'new-id', entityId: 'txn-B', fileSize: bytes.length };
    await bindQboAttachmentIdentities('realm-1', [attachment], docs);
    expect(findInboxDocumentForAttachable(attachment, docs)).toBe(sameBytes ? docs[0] : null);
    expect(query.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
  });

  it('flags a proven file on the wrong transaction without confusing it with that transaction’s own document', async () => {
    const docs = [
      { id: 'doc-A', matched_transaction_id: 'txn-A', verified_qbo_attachable_ids: ['att-A'] },
      { id: 'doc-B', matched_transaction_id: 'txn-B', verified_qbo_attachable_ids: ['att-B'] },
    ];
    const txns = ['txn-A', 'txn-B'].map(txnId => ({ txnId, txnType: 'Bill', date: '2026-10-01', vendor: 'Vendor', amount: 10, docNumber: txnId }));
    const result = await analyzeQboSide(txns, [{ attachableId: 'att-A', entityId: 'txn-B', fileName: 'misleading-name.pdf' }], docs, new Map(), new Map([['doc-A', {
      documentId: 'doc-A', status: 'matched' as const, transactionId: 'txn-A', confidence: 100,
      matchSignals: { vendorMatch: true, amountMatch: true, dateMatch: true, documentNumberMatch: true },
    }]]), undefined, 'realm-1');
    expect(result.find(row => row.attachableId === 'att-A')).toMatchObject({ qboTxnId: 'txn-B', matchedDocumentId: 'doc-A', registerState: 'WRONG_MATCHED', correctQboTxnId: 'txn-A' });
  });

  it('still proves a wrong QBO association when the correct transaction is already claimed', async () => {
    const txns = ['txn-A', 'txn-B'].map(txnId => ({ txnId, txnType: 'Bill', date: '2026-10-01', vendor: 'Vendor', amount: 10, docNumber: txnId }));
    const doc = { id: 'doc-A', extracted_vendor: 'Vendor', extracted_amount: 10, extracted_date: '2026-10-01', extracted_document_number: 'txn-A' };
    mocks.from.mockImplementation((table: string) => {
      const query: Record<string, any> = {};
      for (const method of ['select', 'eq', 'is', 'order', 'range']) query[method] = vi.fn(() => query);
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === 'inbox_documents' ? [doc] : [{ inbox_document_id: doc.id, qbo_attachable_id: '1009', qbo_attachment_status: 'verified' }], error: null }).then(resolve);
      return query;
    });
    vi.mocked(getClaimedTransactionIds).mockResolvedValue(new Set(['txn-A']));
    vi.mocked(matchDocumentToTransactions).mockImplementation(async (...args) => ({
      documentId: args[0], status: args[6] ? 'matched' : 'multiple_candidates', transactionId: args[6] ? 'txn-A' : null,
      confidence: 100, matchedTransaction: txns[0], matchSignals: { vendorMatch: true, amountMatch: true, dateMatch: true, documentNumberMatch: true },
    }));
    const result = await buildQboEvidenceRegister({ realmId: 'realm-1', transactions: txns, attachables: [{ attachableId: '1009', entityId: 'txn-B', fileName: 'wrong.pdf' }] });
    expect(result.find(row => row.attachableId === '1009')).toMatchObject({ registerState: 'WRONG_MATCHED', correctQboTxnId: 'txn-A' });
    expect(matchDocumentToTransactions).toHaveBeenCalledWith(doc.id, expect.anything(), undefined, txns, 'realm-1', expect.any(Set), true);
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
