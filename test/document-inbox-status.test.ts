import { describe, expect, it } from 'vitest';
import { getDocumentStatusLabel, getDocumentStatusReason, getMatchComparisonRows, getMatchComparisonSummary, getMatchEvidenceDetails, type StoredDocument } from '@/app/documents/types';

const base: StoredDocument = {
  id: 'document-1', name: 'receipt.pdf', type: 'application/pdf', size: 10,
  uploadedAt: '2026-11-21T00:00:00Z', status: 'processed',
};

describe('document inbox evidence status labels', () => {
  it.each([
    [{ ...base, matchStatus: 'verified', reviewStatus: 'not_required', evidenceRole: 'primary' }, 'Matched'],
    [{ ...base, matchStatus: 'verified', reviewStatus: 'required', evidenceRole: 'additional' }, 'Additional evidence'],
    [{ ...base, matchStatus: 'duplicate', reviewStatus: 'required', evidenceRole: 'unassigned' }, 'Duplicate found'],
    [{ ...base, matchStatus: 'potential', reviewStatus: 'required', evidenceRole: 'unassigned' }, 'Needs review'],
    [{ ...base, matchStatus: 'wrong_match', reviewStatus: 'required', evidenceRole: 'unassigned' }, 'Needs review'],
    [{ ...base, status: 'failed', processingError: 'OCR failed' }, 'Processing failed'],
  ] satisfies Array<[StoredDocument, string]>)('maps evidence state to %s', (document, expected) => {
    expect(getDocumentStatusLabel(document)).toBe(expected);
  });

  it('explains why additional evidence requires review', () => {
    expect(getDocumentStatusReason({ ...base, matchStatus: 'verified', reviewStatus: 'required', evidenceRole: 'additional' }))
      .toContain('already has primary evidence');
  });

  it('flattens nested match evidence into readable details', () => {
    expect(getMatchEvidenceDetails({ signals: { vendorMatch: true, amountMatch: false }, reasons: ['date', 'amount'], comparisons: [{ expected: 10, actual: 10 }] }))
      .toEqual([
        { label: 'signals vendor match', value: 'Yes' },
        { label: 'signals amount match', value: 'No' },
        { label: 'reasons', value: 'date, amount' },
        { label: 'comparisons 1 expected', value: '10' },
        { label: 'comparisons 1 actual', value: '10' },
      ]);
  });

  it('presents uploaded and QuickBooks values as a highlighted comparison', () => {
    const rows = getMatchComparisonRows([{ fieldComparisons: [
      { fieldName: 'vendorName', match: false, documentValue: "Bill's Windsurf Shop", transactionValue: "Amy's Bird Sanctuary" },
      { fieldName: 'totalAmount', match: true, documentValue: 108, transactionValue: 108 },
    ] }]);
    expect(rows).toEqual([
      { field: 'Vendor or customer', documentValue: "Bill's Windsurf Shop", transactionValue: "Amy's Bird Sanctuary", matches: false },
      { field: 'Amount', documentValue: '108', transactionValue: '108', matches: true },
    ]);
    expect(getMatchComparisonSummary(rows)).toBe('vendor or customer differs; amount agrees.');
  });
});
