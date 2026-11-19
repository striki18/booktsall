import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rows: new Map<string, unknown[]>() }));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from, rpc: vi.fn() } }));
vi.mock('../lib/document-extraction', () => ({
  matchDocumentToTransactions: vi.fn(), extractFieldsFromText: vi.fn(), getCollectionRequestWithTransactions: vi.fn(),
  downloadDocument: vi.fn(), getClaimedTransactionIds: vi.fn(),
}));
vi.mock('../lib/quickbooks', () => ({
  getAttachables: vi.fn(), normalizeAttachables: vi.fn(), getTransactions: vi.fn(), normalizeTransactionList: vi.fn(),
}));

import { applyStoredEvidenceReviewDecisions } from '@/lib/qbo-evidence-register';

function queryFor(table: string) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mocks.rows.get(table) ?? [], error: null }).then(resolve),
  };
  return query;
}

describe('durable reviewer decision loading', () => {
  it('replays company-scoped decisions against a recomputed document row after rerun', async () => {
    mocks.from.mockImplementation((table: string) => queryFor(table));
    mocks.rows.set('qbo_evidence_register', [{
      id: 'register-row-1', realm_id: 'realm-1', collection_request_id: null, qbo_txn_id: null,
      qbo_txn_type: 'Bill', qbo_txn_date: '2026-11-01', qbo_txn_vendor: 'Vendor', qbo_txn_amount: 40,
      qbo_txn_doc_number: 'B-1', attachable_id: null, attachment_filename: 'receipt.pdf',
      attachment_file_size: 100, attachment_download_url: null, register_state: 'REVIEW_REQUIRED',
      matched_document_id: 'document-1', match_confidence: 80, match_field_details: null,
      correct_qbo_txn_id: null, review_candidate_txn_ids: ['txn-1'],
    }]);
    mocks.rows.set('evidence_review_decisions', [{
      id: 'decision-1', realm_id: 'realm-1', register_entry_id: 'old-register-row', evidence_document_id: 'document-1',
      reviewer_user_id: 'user-1', action: 'assign_transaction', selected_qbo_txn_id: 'txn-1',
      rationale: 'Verified invoice number', created_at: '2026-11-02T00:00:00Z',
    }]);

    const computed = [{
      realmId: 'realm-1', collectionRequestId: null, qboTxnId: null, qboTxnType: 'Bill', qboTxnDate: '2026-11-01',
      qboTxnVendor: 'Vendor', qboTxnAmount: 40, qboTxnDocNumber: 'B-1', attachableId: null,
      attachmentFilename: 'receipt.pdf', attachmentFileSize: 100, attachmentDownloadUrl: null,
      registerState: 'REVIEW_REQUIRED' as const, matchedDocumentId: 'document-1', matchConfidence: 80,
      matchFieldDetails: null, correctQboTxnId: null, reviewCandidateTxnIds: ['txn-1'],
    }];

    const effective = await applyStoredEvidenceReviewDecisions(computed, 'realm-1');

    expect(effective[0].id).toBe('register-row-1');
    expect(effective[0].qboTxnId).toBe('txn-1');
    expect(effective[0].registerState).toBe('MATCHED');
    expect(effective[0].humanApproved).toBe(true);
    expect(effective[0].reviewHistory?.map(decision => decision.id)).toEqual(['decision-1']);
    expect(mocks.from).toHaveBeenCalledWith('qbo_evidence_register');
    expect(mocks.from).toHaveBeenCalledWith('evidence_review_decisions');
  });
});
