import { describe, expect, it } from 'vitest';
import { filterQboTransactions } from '@/lib/transaction-search';

const transactions = [
  { txnId: 'txn-1', txnType: 'Bill', date: '2026-10-01', vendor: 'Northwind Supplies', amount: 125.5, docNumber: 'INV-125' },
  { txnId: 'txn-2', txnType: 'Invoice', date: '2026-10-02', vendor: 'Contoso', amount: 250, docNumber: 'INV-250' },
];

describe('company-scoped QBO transaction search filtering', () => {
  it('searches transaction IDs, vendor, document number, type, date and amount', () => {
    expect(filterQboTransactions(transactions, 'northwind').map(row => row.txnId)).toEqual(['txn-1']);
    expect(filterQboTransactions(transactions, 'INV-250').map(row => row.txnId)).toEqual(['txn-2']);
    expect(filterQboTransactions(transactions, '250').map(row => row.txnId)).toEqual(['txn-2']);
  });

  it('returns no rows for an empty search and caps result size', () => {
    expect(filterQboTransactions(transactions, '   ')).toEqual([]);
    expect(filterQboTransactions([...transactions, ...transactions], 'inv', 2)).toHaveLength(2);
  });
});
