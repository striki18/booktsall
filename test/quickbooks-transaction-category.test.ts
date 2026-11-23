import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }));

import { isExplicitlyUncategorized, normalizeTransactionList } from '../lib/quickbooks';

describe('QuickBooks transaction categories', () => {
  it('preserves Account and Split and marks an explicit QBO Uncategorized value', () => {
    const report = {
      Columns: { Column: [
        { ColTitle: 'Date' }, { ColTitle: 'Transaction Type' }, { ColTitle: 'Num' },
        { ColTitle: 'Name' }, { ColTitle: 'Account' }, { ColTitle: 'Split' }, { ColTitle: 'Amount' },
      ] },
      Rows: { Row: [{ ColData: [
        { value: '2026-11-23' }, { value: 'Expense', id: 'txn-1' }, { value: '42' },
        { value: 'Supplier' }, { value: 'Bank' }, { value: 'Uncategorized Expense' }, { value: '25.00' },
      ] }] },
    };

    expect(normalizeTransactionList(report)).toEqual([expect.objectContaining({
      txnId: 'txn-1', account: 'Bank', split: 'Uncategorized Expense', uncategorized: true,
    })]);
  });

  it('does not treat missing or ordinary categories as uncategorized', () => {
    expect(isExplicitlyUncategorized(null, null)).toBe(false);
    expect(isExplicitlyUncategorized('Checking', 'Office Supplies')).toBe(false);
    expect(isExplicitlyUncategorized('Expenses:Uncategorized Expense', null)).toBe(true);
  });
});
