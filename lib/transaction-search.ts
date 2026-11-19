export interface SearchableQboTransaction {
  txnId: string | null;
  txnType?: string | null;
  date?: string | null;
  vendor?: string | null;
  amount?: number | null;
  docNumber?: string | null;
}

/** Search only the already company-scoped transaction result supplied by the caller. */
export function filterQboTransactions<T extends SearchableQboTransaction>(
  transactions: T[],
  query: string,
  limit = 25,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || !Number.isInteger(limit) || limit < 1) return [];
  return transactions.filter((transaction) => [
    transaction.txnId,
    transaction.txnType,
    transaction.date,
    transaction.vendor,
    transaction.amount === null || transaction.amount === undefined ? '' : String(transaction.amount),
    transaction.docNumber,
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(normalized))).slice(0, limit);
}
