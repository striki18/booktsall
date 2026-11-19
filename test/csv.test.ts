import { describe, expect, it } from 'vitest';
import { escapeCsvValue, generateCsv, generateEvidenceRegisterCsv } from '../lib/csv';

describe('CSV formula injection protection', () => {
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
});
