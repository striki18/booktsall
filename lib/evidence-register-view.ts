export type EvidenceRegisterState = 'MATCHED' | 'MISSING' | 'REVIEW_REQUIRED' | 'WRONG_MATCHED';

/** Evidence-item reviews supersede legacy document decisions, including resolved items. */
export function legacyReviewEntries<T extends { matchedDocumentId: string | null; registerState: EvidenceRegisterState }>(
  entries: T[], managedDocumentIds: string[] | null,
): T[] {
  if (managedDocumentIds === null) return []; // Fail closed until ownership is known.
  const managed = new Set(managedDocumentIds);
  return entries.filter(entry => (entry.registerState === 'REVIEW_REQUIRED' || entry.registerState === 'WRONG_MATCHED') &&
    (!entry.matchedDocumentId || !managed.has(entry.matchedDocumentId)));
}
export type EvidenceRegisterSort = 'date_desc' | 'date_asc' | 'amount_desc' | 'vendor_asc';

export interface EvidenceRegisterViewRow {
  qboTxnId: string | null;
  attachedQboTxnId?: string | null;
  qboTxnType?: string | null;
  qboTxnDate?: string | null;
  qboTxnVendor?: string | null;
  qboTxnAmount?: number | null;
  qboTxnDocNumber?: string | null;
  attachmentFilename?: string | null;
  registerState: EvidenceRegisterState;
  [key: string]: unknown;
}

export function filterAndSortEvidenceRegister<T extends EvidenceRegisterViewRow>(
  rows: T[],
  state: EvidenceRegisterState | 'ALL',
  query: string,
  sort: EvidenceRegisterSort,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    if (state !== 'ALL' && row.registerState !== state) return false;
    if (!needle) return true;
    return [
      row.qboTxnId,
      row.attachedQboTxnId,
      row.qboTxnType,
      row.qboTxnDate,
      row.qboTxnVendor,
      row.qboTxnAmount,
      row.qboTxnDocNumber,
      row.attachmentFilename,
      row.registerState,
    ].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
  });

  return filtered.sort((left, right) => {
    if (sort === 'amount_desc') return (right.qboTxnAmount ?? Number.NEGATIVE_INFINITY) - (left.qboTxnAmount ?? Number.NEGATIVE_INFINITY);
    if (sort === 'vendor_asc') return (left.qboTxnVendor ?? '').localeCompare(right.qboTxnVendor ?? '');
    const dateOrder = (left.qboTxnDate ?? '').localeCompare(right.qboTxnDate ?? '');
    return sort === 'date_asc' ? dateOrder : -dateOrder;
  });
}

export function countEvidenceRegisterStates(rows: EvidenceRegisterViewRow[]) {
  return rows.reduce<Record<EvidenceRegisterState, number>>((counts, row) => {
    counts[row.registerState] += 1;
    return counts;
  }, { MATCHED: 0, MISSING: 0, REVIEW_REQUIRED: 0, WRONG_MATCHED: 0 });
}
