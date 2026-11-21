import { describe, expect, it } from 'vitest';
import { escapeCsvValue, generateCsv, generateEvidenceRegisterCsv } from '../lib/csv';

describe('CSV formula injection protection', () => {
  it('retains both the actual wrong attachment target and the correct transaction reference', () => {
    const csv = generateEvidenceRegisterCsv([{ qboTxnId: null, attachedQboTxnId: '12', correctQboTxnId: '9', registerState: 'WRONG_MATCHED' }]);
    expect(csv.split('\n')[0]).toContain('Transaction ID,Correct Transaction ID');
    expect(csv.split('\n')[1]).toContain('WRONG_MATCHED');
    expect(csv.split('\n')[1]).toMatch(/,12,9$/);
  });
  it.each(['=1+1', '+SUM(A1:A2)', '-2+3', '@SUM(A1)', "\t=1+1", "  =1+1"])(
    'neutralizes formula-leading cell %j', (value) => {
      expect(escapeCsvValue(value)).toBe(`'${value}`);
    },
  );

  it('keeps ordinary and CSV-escaped values intact', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
  });

  it('neutralizes formula values in generated rows', () => {
    expect(generateCsv([{ name: '=HYPERLINK("https://example.invalid")' }], [{ key: 'name', header: 'Name' }]))
      .toBe('Name\n"\'=HYPERLINK(""https://example.invalid"")"');
  });

  it('exports the latest reviewer decision and append-only decision history', () => {
    const csv = generateEvidenceRegisterCsv([{
      qboTxnDate: '2026-11-01', qboTxnType: 'Bill', qboTxnDocNumber: 'B-1', qboTxnVendor: 'Vendor', qboTxnAmount: 42,
      attachmentFilename: 'receipt.pdf', attachableId: null, registerState: 'REVIEW_REQUIRED', humanApproved: true,
      reviewDecision: { action: 'assign_transaction', selected_qbo_txn_id: 'txn-1', reviewer_user_id: 'user-1', created_at: '2026-11-02T00:00:00Z', rationale: 'Second valid receipt' },
      reviewHistory: [{ id: 'decision-1', action: 'assign_transaction' }],
    }]);

    expect(csv).toContain('Human Approved,Latest Review Decision,Reviewed Transaction ID,Reviewer User ID,Decision Timestamp,Decision Rationale,Decision History');
    expect(csv).toContain('YES,assign_transaction,txn-1,user-1,2026-11-02T00:00:00Z,Second valid receipt');
    expect(csv).toContain('"[{""id"":""decision-1"",""action"":""assign_transaction""}]"');
  });

  it('exports item-level identity, evidence role, review state, and QBO attachment state', () => {
    const csv = generateEvidenceRegisterCsv([{
      qboTxnDate: '2026-11-01', qboTxnType: 'Bill', qboTxnDocNumber: 'B-7', qboTxnVendor: 'Vendor', qboTxnAmount: 77,
      attachmentFilename: 'second-receipt.pdf', attachableId: '9002', registerState: 'MATCHED',
      evidenceItemId: 'item-2', evidenceRole: 'additional', evidenceReviewStatus: 'approved', qboAttachmentStatus: 'verified',
    }]);

    expect(csv).toContain('Evidence Item ID,Evidence Role,Evidence Review Status,QBO Attachment Status');
    expect(csv).toContain('item-2,additional,approved,verified');
  });
});
