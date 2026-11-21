import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), responses: new Map<string, unknown[]>() }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from } }));

import { addApprovedEvidenceItemsToPackage } from '@/lib/evidence-items-package';
import type { RegisterEntry } from '@/lib/qbo-evidence-register';

const realmId = 'realm-934';
const registerId = '22222222-2222-4222-8222-222222222222';
const primaryDocId = '33333333-3333-4333-8333-333333333333';
const additionalDocId = '44444444-4444-4444-8444-444444444444';
const primaryItemId = '55555555-5555-4555-8555-555555555555';
const additionalItemId = '66666666-6666-4666-8666-666666666666';

const entry: RegisterEntry = {
  id: registerId, realmId, collectionRequestId: null,
  qboTxnId: 'txn-7', qboTxnType: 'Bill', qboTxnDate: '2026-11-01', qboTxnVendor: 'Vendor', qboTxnAmount: 77,
  qboTxnDocNumber: 'B-7', attachableId: null, attachmentFilename: 'primary.pdf', attachmentFileSize: null,
  attachmentDownloadUrl: null, registerState: 'MATCHED', matchedDocumentId: primaryDocId,
  matchConfidence: 100, matchFieldDetails: null, correctQboTxnId: null, reviewCandidateTxnIds: [],
};

function query(table: string) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order']) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (result: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    const result = mocks.responses.get(table)?.shift() ?? { data: [], error: null };
    return Promise.resolve(result).then(resolve, reject);
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.responses = new Map();
  mocks.from.mockImplementation((table: string) => query(table));
});

describe('approved evidence package overlay', () => {
  it('does not package a discarded document even when recomputation or an old approval still marks it matched', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [], error: null },
      { data: [], error: null },
      { data: [{ inbox_document_id: primaryDocId }], error: null },
    ]);
    const input = { ...entry, humanApproved: true };
    const output = await addApprovedEvidenceItemsToPackage([input], realmId);
    expect(output[0]).toMatchObject({
      matchedDocumentId: primaryDocId, evidenceReviewStatus: 'discarded',
      registerState: 'REVIEW_REQUIRED', humanApproved: false,
    });
    expect(input.registerState).toBe('MATCHED');
    expect(input.humanApproved).toBe(true);
  });

  it('fails closed when the current discard decisions cannot be read', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [], error: null }, { data: [], error: null },
      { data: null, error: { message: 'unavailable' } },
    ]);
    await expect(addApprovedEvidenceItemsToPackage([entry], realmId)).rejects.toThrow('Discarded evidence could not be checked');
  });

  it('does not restore an earlier approval after the discard check observes a newer decision', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [{ id: additionalItemId, realm_id: realmId, register_entry_id: registerId,
        source_type: 'client_upload', inbox_document_id: primaryDocId, match_status: 'verified',
        review_status: 'approved', evidence_role: 'additional', qbo_attachment_status: 'not_requested' }], error: null },
      { data: [], error: null },
      { data: [{ inbox_document_id: primaryDocId }], error: null },
    ]);
    const output = await addApprovedEvidenceItemsToPackage([entry], realmId);
    expect(output[0]).toMatchObject({ evidenceReviewStatus: 'discarded', humanApproved: false, registerState: 'REVIEW_REQUIRED' });
    expect(mocks.from).not.toHaveBeenCalledWith('qbo_evidence_item_review_events');
  });

  it('includes approved additional documents and immutable decisions without changing primary or missing state', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [{ id: additionalItemId, realm_id: realmId, register_entry_id: registerId, source_type: 'client_upload', inbox_document_id: additionalDocId, qbo_attachable_id: '9002', match_status: 'verified', review_status: 'approved', evidence_role: 'additional', qbo_attachment_status: 'verified' }], error: null },
      { data: [{ id: primaryItemId, realm_id: realmId, register_entry_id: registerId, source_type: 'client_upload', inbox_document_id: primaryDocId, qbo_attachable_id: '9001', match_status: 'verified', review_status: 'not_required', evidence_role: 'primary', qbo_attachment_status: 'verified' }], error: null },
    ]);
    mocks.responses.set('inbox_documents', [{ data: [
      { id: primaryDocId, realm_id: realmId, filename: 'primary.pdf' },
      { id: additionalDocId, realm_id: realmId, filename: 'second-receipt.pdf' },
    ], error: null }]);
    mocks.responses.set('qbo_evidence_item_review_events', [{ data: [{
      id: 'review-event-1', evidence_item_id: additionalItemId, reviewer_user_id: 'reviewer-1',
      action: 'approve_additional', selected_register_entry_id: registerId,
      rationale: 'Confirmed supporting receipt', created_at: '2026-11-02T10:00:00Z',
    }], error: null }]);

    const output = await addApprovedEvidenceItemsToPackage([entry], realmId);

    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({ ...entry, attachableId: '9001', evidenceItemId: primaryItemId, evidenceRole: 'primary', evidenceReviewStatus: 'not_required', qboAttachmentStatus: 'verified' });
    expect(output[1]).toMatchObject({
      id: registerId, qboTxnId: 'txn-7', matchedDocumentId: additionalDocId,
      attachmentFilename: 'second-receipt.pdf', attachableId: '9002', registerState: 'MATCHED',
      humanApproved: true, evidenceItemId: additionalItemId, evidenceRole: 'additional',
      evidenceReviewStatus: 'approved', qboAttachmentStatus: 'verified',
      reviewDecision: { action: 'approve_additional', selected_qbo_txn_id: 'txn-7', reviewer_user_id: 'reviewer-1' },
      reviewHistory: [{ id: 'review-event-1', action: 'approve_additional', selected_qbo_txn_id: 'txn-7' }],
    });
    expect(entry).toEqual(expect.objectContaining({ registerState: 'MATCHED', matchedDocumentId: primaryDocId }));
    expect(mocks.from).toHaveBeenCalledWith('qbo_evidence_items');
  });

  it('fails closed when an approved additional document lacks its matching immutable approval event', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [{ id: additionalItemId, realm_id: realmId, register_entry_id: registerId, source_type: 'client_upload', inbox_document_id: additionalDocId, match_status: 'verified', review_status: 'approved', evidence_role: 'additional', qbo_attachment_status: 'failed' }], error: null },
      { data: [], error: null },
    ]);
    mocks.responses.set('inbox_documents', [{ data: [{ id: additionalDocId, realm_id: realmId, filename: 'second-receipt.pdf' }], error: null }]);
    mocks.responses.set('qbo_evidence_item_review_events', [{ data: [], error: null }]);

    await expect(addApprovedEvidenceItemsToPackage([entry], realmId)).rejects.toThrow('missing its matching immutable review event');
  });

  it('reflects a reviewer-confirmed first match in the package without retaining a stale missing state', async () => {
    const missingEntry = { ...entry, registerState: 'MISSING' as const, matchedDocumentId: null, attachmentFilename: null };
    mocks.responses.set('qbo_evidence_items', [
      { data: [], error: null },
      { data: [{ id: primaryItemId, realm_id: realmId, register_entry_id: registerId, source_type: 'client_upload', inbox_document_id: primaryDocId, qbo_attachable_id: '9001', match_status: 'verified', review_status: 'not_required', evidence_role: 'primary', qbo_attachment_status: 'verified' }], error: null },
    ]);
    mocks.responses.set('inbox_documents', [{ data: [{ id: primaryDocId, realm_id: realmId, filename: 'confirmed-receipt.pdf' }], error: null }]);
    mocks.responses.set('qbo_evidence_item_review_events', [{ data: [{
      id: 'confirm-event', evidence_item_id: primaryItemId, reviewer_user_id: 'reviewer-1',
      action: 'confirm_match', selected_register_entry_id: registerId,
      rationale: 'Verified against the source document', created_at: '2026-11-03T10:00:00Z',
    }], error: null }]);

    const output = await addApprovedEvidenceItemsToPackage([missingEntry], realmId);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      qboTxnId: 'txn-7', registerState: 'MATCHED', matchedDocumentId: primaryDocId,
      attachmentFilename: 'confirmed-receipt.pdf', humanApproved: true, evidenceItemId: primaryItemId,
      reviewDecision: { action: 'confirm_match', selected_qbo_txn_id: 'txn-7' },
    });
    expect(missingEntry.registerState).toBe('MISSING');
  });

  it('returns the original register without querying when no persisted transaction IDs are available', async () => {
    const input = [{ ...entry, id: undefined }];
    await expect(addApprovedEvidenceItemsToPackage(input, realmId)).resolves.toBe(input);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('preserves a proven wrong association and the earlier human approval together', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [{ id: additionalItemId, realm_id: realmId, register_entry_id: registerId, source_type: 'client_upload', inbox_document_id: additionalDocId,
        qbo_attachable_id: '9002', match_status: 'verified', review_status: 'approved', evidence_role: 'additional', qbo_attachment_status: 'verified' }], error: null },
      { data: [], error: null },
    ]);
    mocks.responses.set('inbox_documents', [{ data: [{ id: additionalDocId, realm_id: realmId, filename: 'approved-but-wrong.pdf' }], error: null }]);
    mocks.responses.set('qbo_evidence_item_review_events', [{ data: [{ id: 'approval', evidence_item_id: additionalItemId, reviewer_user_id: 'reviewer', action: 'approve_additional', selected_register_entry_id: registerId, created_at: '2026-11-01' }], error: null }]);
    const wrong = { ...entry, matchedDocumentId: additionalDocId, attachableId: '9002', registerState: 'WRONG_MATCHED' as const, correctQboTxnId: 'actual-txn' };
    const result = await addApprovedEvidenceItemsToPackage([wrong], realmId);
    expect(result[0]).toMatchObject({ registerState: 'WRONG_MATCHED', correctQboTxnId: 'actual-txn', humanApproved: true, reviewHistory: [expect.objectContaining({ id: 'approval' })] });
    expect(wrong.registerState).toBe('WRONG_MATCHED');
  });

  it('preserves a QBO-verified automatic primary after a rerun produces a conflicting document suggestion', async () => {
    mocks.responses.set('qbo_evidence_items', [
      { data: [], error: null },
      { data: [{ id: primaryItemId, realm_id: realmId, register_entry_id: registerId, source_type: 'client_upload', inbox_document_id: primaryDocId,
        qbo_attachable_id: '9001', match_status: 'verified', review_status: 'not_required', evidence_role: 'primary', qbo_attachment_status: 'verified' }], error: null },
    ]);
    mocks.responses.set('inbox_documents', [{ data: [{ id: primaryDocId, realm_id: realmId, filename: 'primary.pdf' }], error: null }]);
    mocks.responses.set('qbo_evidence_item_review_events', [{ data: [], error: null }]);
    const computed = { ...entry, attachableId: null, registerState: 'REVIEW_REQUIRED' as const, matchedDocumentId: additionalDocId };
    const qboRelationship = { ...entry, id: undefined, attachableId: '9001', matchedDocumentId: null, registerState: 'REVIEW_REQUIRED' as const };
    const result = await addApprovedEvidenceItemsToPackage([qboRelationship, computed], realmId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ evidenceItemId: primaryItemId, matchedDocumentId: primaryDocId, registerState: 'MATCHED' });
    expect(result[0].humanApproved).not.toBe(true);
    expect(computed.matchedDocumentId).toBe(additionalDocId);
  });
});
