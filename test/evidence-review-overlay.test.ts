import { describe, expect, it } from 'vitest';
import { applyEvidenceReviewDecisions, attachPersistedRegisterIds, type EvidenceReviewDecision } from '@/lib/evidence-review';
import type { RegisterEntry } from '@/lib/qbo-evidence-register';

function entry(input: Partial<RegisterEntry> & Pick<RegisterEntry, 'matchedDocumentId' | 'qboTxnId' | 'registerState'>): RegisterEntry {
  return {
    realmId: 'realm-1', collectionRequestId: null,
    qboTxnType: 'Bill', qboTxnDate: '2026-10-01', qboTxnVendor: 'Acme', qboTxnAmount: 100,
    qboTxnDocNumber: 'INV-1', attachableId: null, attachmentFilename: null, attachmentFileSize: null,
    attachmentDownloadUrl: null, matchConfidence: null, matchFieldDetails: null, correctQboTxnId: null,
    reviewCandidateTxnIds: [], ...input,
  };
}

function decision(input: Partial<EvidenceReviewDecision> & Pick<EvidenceReviewDecision, 'id' | 'register_entry_id' | 'evidence_document_id' | 'action' | 'created_at'>): EvidenceReviewDecision {
  return {
    realm_id: 'realm-1', reviewer_user_id: 'user-1', selected_qbo_txn_id: null, rationale: null,
    ...input,
  };
}

describe('evidence decision overlay', () => {
  it('reapplies durable decisions by document after recomputation and retains every approved document', () => {
    const computed = [
      entry({ matchedDocumentId: 'doc-primary', qboTxnId: 'txn-1', registerState: 'MATCHED' }),
      entry({ matchedDocumentId: 'doc-second', qboTxnId: null, registerState: 'REVIEW_REQUIRED', reviewCandidateTxnIds: ['txn-1'] }),
      entry({ matchedDocumentId: 'doc-third', qboTxnId: null, registerState: 'REVIEW_REQUIRED', reviewCandidateTxnIds: ['txn-1'] }),
    ];
    const persisted = [
      { ...computed[0], id: 'entry-primary' },
      { ...computed[1], id: 'entry-second' },
      { ...computed[2], id: 'entry-third' },
    ];
    const withIds = attachPersistedRegisterIds(computed, persisted);
    const decisions = [
      decision({ id: 'decision-1', register_entry_id: 'entry-second', evidence_document_id: 'doc-second', action: 'assign_transaction', selected_qbo_txn_id: 'txn-1', created_at: '2026-11-01T00:00:00Z' }),
      decision({ id: 'decision-2', register_entry_id: 'entry-third', evidence_document_id: 'doc-third', action: 'confirm_match', selected_qbo_txn_id: 'txn-1', created_at: '2026-11-02T00:00:00Z' }),
    ];

    const result = applyEvidenceReviewDecisions(withIds, decisions);

    expect(result.map(row => row.matchedDocumentId)).toEqual(['doc-primary', 'doc-second', 'doc-third']);
    expect(result.map(row => row.registerState)).toEqual(['MATCHED', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
    expect(result.slice(1).every(row => row.qboTxnId === 'txn-1' && row.humanApproved)).toBe(true);
    expect(result.slice(1).map(row => row.reviewDecision?.action)).toEqual(['assign_transaction', 'confirm_match']);
  });

  it('uses the newest append-only decision for a register entry and preserves the full history', () => {
    const computed = [entry({ id: 'entry-1', matchedDocumentId: 'doc-1', qboTxnId: 'txn-1', registerState: 'MATCHED' })];
    const result = applyEvidenceReviewDecisions(computed, [
      decision({ id: 'decision-old', register_entry_id: 'entry-1', evidence_document_id: 'doc-1', action: 'confirm_match', selected_qbo_txn_id: 'txn-1', created_at: '2026-11-01T00:00:00Z' }),
      decision({ id: 'decision-new', register_entry_id: 'entry-1', evidence_document_id: 'doc-1', action: 'reject_match', created_at: '2026-11-02T00:00:00Z' }),
    ]);

    expect(result[0].registerState).toBe('REVIEW_REQUIRED');
    expect(result[0].reviewDecision?.id).toBe('decision-new');
    expect(result[0].reviewHistory?.map(row => row.id)).toEqual(['decision-old', 'decision-new']);
  });
});
