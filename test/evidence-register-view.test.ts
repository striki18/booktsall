import { describe, expect, it } from 'vitest';
import { countEvidenceRegisterStates, filterAndSortEvidenceRegister, legacyReviewEntries } from '../lib/evidence-register-view';

const rows = [
  { qboTxnId: '1', qboTxnDate: '2026-02-01', qboTxnVendor: 'Zebra', qboTxnAmount: 20, qboTxnDocNumber: 'INV-1', attachmentFilename: 'invoice.pdf', registerState: 'MATCHED' as const },
  { qboTxnId: '2', qboTxnDate: '2026-02-03', qboTxnVendor: 'Acme', qboTxnAmount: 80, qboTxnDocNumber: 'BILL-2', attachmentFilename: null, registerState: 'MISSING' as const },
  { qboTxnId: '3', qboTxnDate: '2026-02-02', qboTxnVendor: 'Acme', qboTxnAmount: 40, qboTxnDocNumber: 'INV-3', attachmentFilename: 'possible.pdf', registerState: 'REVIEW_REQUIRED' as const },
  { qboTxnId: '4', qboTxnDate: '2026-02-04', qboTxnVendor: 'Beta', qboTxnAmount: 60, qboTxnDocNumber: 'BILL-4', attachmentFilename: 'wrong.pdf', registerState: 'WRONG_MATCHED' as const },
];

describe('evidence register list controls', () => {
  it('never offers legacy decisions for managed documents or when ownership lookup fails', () => {
    const entries = [
      { matchedDocumentId: 'primary', registerState: 'REVIEW_REQUIRED' as const },
      { matchedDocumentId: 'duplicate', registerState: 'REVIEW_REQUIRED' as const },
      { matchedDocumentId: 'legacy', registerState: 'WRONG_MATCHED' as const },
    ];
    expect(legacyReviewEntries(entries, ['primary', 'duplicate'])).toEqual([entries[2]]);
    expect(legacyReviewEntries(entries, null)).toEqual([]);
  });
  it('counts all four register states without changing the rows', () => {
    expect(countEvidenceRegisterStates(rows)).toEqual({ MATCHED: 1, MISSING: 1, REVIEW_REQUIRED: 1, WRONG_MATCHED: 1 });
    expect(rows).toHaveLength(4);
  });

  it('filters by state and case-insensitive transaction or document text', () => {
    expect(filterAndSortEvidenceRegister(rows, 'MISSING', '', 'date_desc').map((row) => row.qboTxnId)).toEqual(['2']);
    expect(filterAndSortEvidenceRegister(rows, 'ALL', 'possible.PDF', 'date_desc').map((row) => row.qboTxnId)).toEqual(['3']);
    expect(filterAndSortEvidenceRegister(rows, 'ALL', 'acme', 'date_desc').map((row) => row.qboTxnId)).toEqual(['2', '3']);
  });

  it('sorts by date, amount, or vendor deterministically', () => {
    expect(filterAndSortEvidenceRegister(rows, 'ALL', '', 'date_asc').map((row) => row.qboTxnId)).toEqual(['1', '3', '2', '4']);
    expect(filterAndSortEvidenceRegister(rows, 'ALL', '', 'amount_desc').map((row) => row.qboTxnId)).toEqual(['2', '4', '3', '1']);
    expect(filterAndSortEvidenceRegister(rows, 'ALL', '', 'vendor_asc').map((row) => row.qboTxnId)).toEqual(['2', '3', '4', '1']);
  });
});
