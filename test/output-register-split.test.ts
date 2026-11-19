import { describe, expect, it } from 'vitest';
import { splitEvidenceRegister } from '../lib/output';

describe('evidence register CSV row selection', () => {
  it('keeps transaction rows and candidate-linked review rows but excludes unassigned uploads', () => {
    const rows = [
      { id: 'matched', registerState: 'MATCHED', qboTxnId: 'txn-1' },
      { id: 'candidate-review', registerState: 'REVIEW_REQUIRED', qboTxnId: null, reviewCandidateTxnIds: ['txn-1'] },
      { id: 'unassigned-review', registerState: 'REVIEW_REQUIRED', qboTxnId: null, reviewCandidateTxnIds: [] },
      { id: 'transaction-missing', registerState: 'MISSING', qboTxnId: 'txn-2' },
      { id: 'unassigned-missing', registerState: 'MISSING', qboTxnId: null },
    ];
    const result = splitEvidenceRegister(rows);
    expect(result.allEntries.map((row) => row.id)).toEqual(['matched', 'candidate-review']);
    expect(result.missingEntries.map((row) => row.id)).toEqual(['transaction-missing']);
  });
});
