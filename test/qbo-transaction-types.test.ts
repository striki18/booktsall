import { describe, expect, it } from 'vitest';
import { qboTransactionEntityType } from '../lib/qbo-transaction-types';
describe('QBO report labels and API entities', () => {
  it.each(['Expense', 'Cash Expense', 'Credit Card Expense', 'Check', 'Purchase'])('resolves %s to Purchase', label => {
    expect(qboTransactionEntityType(label)).toBe('Purchase');
  });
  it.each([['Invoice', 'Invoice'], ['Sales Receipt', 'SalesReceipt'], ['Journal Entry', 'JournalEntry'], ['Bill Payment (Credit Card)', 'BillPayment']])('resolves %s without changing the display label', (label, entity) => {
    expect(qboTransactionEntityType(label)).toBe(entity);
  });
  it.each(['Charge', 'Inventory Adjust', 'Unknown', 'Invoice; DELETE', '__proto__'])('fails closed for unverified label %s', label => {
    expect(qboTransactionEntityType(label)).toBeNull();
  });
});
