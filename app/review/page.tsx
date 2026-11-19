'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { filterQboTransactions } from '@/lib/transaction-search';
import { WorkspaceHeader, useWordingMode } from '@/app/quickbooks/icons';

type ReviewDecision = {
  id: string;
  action: string;
  selected_qbo_txn_id: string | null;
  reviewer_user_id: string | null;
  rationale: string | null;
  created_at: string;
};

type SearchableTransaction = {
  txnId: string | null;
  txnType?: string | null;
  date?: string | null;
  vendor?: string | null;
  amount?: number | null;
  docNumber?: string | null;
};
type RegisterEntry = {
  id?: string;
  qboTxnId: string | null;
  qboTxnType: string | null;
  qboTxnDate: string | null;
  qboTxnVendor: string | null;
  qboTxnAmount: number | null;
  qboTxnDocNumber: string | null;
  attachmentFilename: string | null;
  matchedDocumentId: string | null;
  registerState: 'MATCHED' | 'MISSING' | 'REVIEW_REQUIRED' | 'WRONG_MATCHED';
  reviewCandidateTxnIds: string[];
  humanApproved?: boolean;
  reviewDecision?: ReviewDecision;
  reviewHistory?: ReviewDecision[];
};

function initialDate(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export default function EvidenceReviewPage() {
  const { wording } = useWordingMode();
  const financeMode = wording === 'finance';
  const [startDate, setStartDate] = useState(initialDate(-30));
  const [endDate, setEndDate] = useState(initialDate(0));
  const [entries, setEntries] = useState<RegisterEntry[]>([]);
  const [selectedTransactions, setSelectedTransactions] = useState<Record<string, string>>({});
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transactionSearch, setTransactionSearch] = useState<Record<string, string>>({});
  const [transactionResults, setTransactionResults] = useState<Record<string, SearchableTransaction[]>>({});
  const [searchedTransactionIds, setSearchedTransactionIds] = useState<Record<string, string[]>>({});
  const [searchingId, setSearchingId] = useState<string | null>(null);

  const loadRegister = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/evidence/register?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load evidence register');
      if (!Array.isArray(body)) throw new Error('Evidence register response was invalid');
      setEntries(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load evidence register');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => { void loadRegister(); }, [loadRegister]);

  const reviewEntries = useMemo(
    () => entries.filter(entry => entry.registerState === 'REVIEW_REQUIRED' || entry.registerState === 'WRONG_MATCHED'),
    [entries],
  );

  async function searchTransactions(entry: RegisterEntry) {
    if (!entry.id) return;
    setSearchingId(entry.id);
    setError(null);
    try {
      const response = await fetch(`/api/quickbooks/transactions?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to search QuickBooks transactions');
      if (!Array.isArray(body)) throw new Error('QuickBooks transaction response was invalid');
      const transactions = body.filter((row: SearchableTransaction): row is SearchableTransaction & { txnId: string } => typeof row.txnId === 'string' && row.txnId.length > 0);
      setTransactionResults(current => ({ ...current, [entry.id!]: transactions }));
      setSearchedTransactionIds(current => ({ ...current, [entry.id!]: transactions.map((row: SearchableTransaction) => row.txnId!) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to search QuickBooks transactions');
    } finally {
      setSearchingId(null);
    }
  }

  async function submitDecision(entry: RegisterEntry, action: 'confirm_match' | 'reject_match' | 'mark_wrong_match' | 'assign_transaction') {
    if (!entry.id) {
      setError('This register row is not persisted yet and cannot receive a review decision. Persist the register, then reload.');
      return;
    }

    const selectedQboTxnId = selectedTransactions[entry.id] || entry.qboTxnId || '';
    if ((action === 'confirm_match' || action === 'assign_transaction' || action === 'mark_wrong_match') && !selectedQboTxnId) {
      setError('Select a QuickBooks transaction before confirming this document.');
      return;
    }

    setSavingId(entry.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/evidence/register/${encodeURIComponent(entry.id)}/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: action === 'confirm_match' && (searchedTransactionIds[entry.id] ?? []).includes(selectedQboTxnId) ? 'assign_transaction' : action,
          selectedQboTxnId: selectedQboTxnId || undefined,
          rationale: rationales[entry.id] || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to save review decision');
      setNotice('Decision recorded. The register and package output now reflect this review.');
      await loadRegister();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save review decision');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent">
      <section className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[#d9dde5] pb-6">
          <div>
            <h1 className="mt-3 text-3xl font-semibold">{financeMode ? 'Evidence review' : 'Items that need a look'}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#5d6675]">{financeMode ? 'Review uncertain evidence matches, possible duplicates, and secondary documents. Every decision is recorded.' : 'Check possible mix-ups, duplicates, and documents that need your decision. We’ll keep a record of what you choose.'}</p>
          </div>
        </header>

        <form onSubmit={event => { event.preventDefault(); void loadRegister(); }} className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-[#d9dde5] bg-white p-4">
          <label className="grid gap-1 text-sm font-medium">Start date<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="h-10 rounded border border-[#c8ced8] px-3" required /></label>
          <label className="grid gap-1 text-sm font-medium">End date<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} className="h-10 rounded border border-[#c8ced8] px-3" required /></label>
          <button disabled={loading} className="h-10 rounded bg-[#243b53] px-4 font-semibold text-white disabled:opacity-60">{loading ? 'Loading…' : 'Refresh register'}</button>
          <span className="ml-auto text-sm text-[#5d6675]">{reviewEntries.length} item{reviewEntries.length === 1 ? '' : 's'} to review</span>
        </form>

        {error ? <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        {notice ? <p role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p> : null}

        {reviewEntries.length === 0 && !loading ? (
          <div className="rounded-lg border border-[#d9dde5] bg-white p-8 text-center text-sm text-[#5d6675]">No review items were returned for this date range.</div>
        ) : (
          <div className="grid gap-4">
            {reviewEntries.map(entry => {
              const key = entry.id || entry.matchedDocumentId || `${entry.qboTxnId}-${entry.attachmentFilename}`;
              const candidateIds = [...new Set([...(entry.qboTxnId ? [entry.qboTxnId] : []), ...entry.reviewCandidateTxnIds])];
              const selectedId = entry.id ? selectedTransactions[entry.id] ?? entry.qboTxnId ?? candidateIds[0] ?? '' : '';
              return (
                <article key={key} className="rounded-lg border border-[#d9dde5] bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#65758b]">{entry.registerState.replace('_', ' ')}</p>
                      <h2 className="mt-1 text-lg font-semibold">{entry.attachmentFilename || 'Evidence document'}</h2>
                      <p className="mt-1 text-sm text-[#5d6675]">{entry.qboTxnDate || 'Date unknown'} · {entry.qboTxnType || 'Transaction'} · {entry.qboTxnDocNumber || 'No document number'} · {entry.qboTxnVendor || 'Vendor unknown'} · {entry.qboTxnAmount ?? 'Amount unknown'}</p>
                    </div>
                    {entry.humanApproved ? <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-800">Approved · additional evidence</span> : null}
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <label className="grid gap-1 text-sm font-medium">Transaction
                      <select value={selectedId} onChange={event => entry.id && setSelectedTransactions(current => ({ ...current, [entry.id!]: event.target.value }))} className="h-10 rounded border border-[#c8ced8] bg-white px-3" disabled={!entry.id}>
                        <option value="">Choose a transaction</option>
                        {candidateIds.map(id => <option key={id} value={id}>{id}</option>)}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm font-medium">Review note
                      <input value={entry.id ? rationales[entry.id] ?? '' : ''} onChange={event => entry.id && setRationales(current => ({ ...current, [entry.id!]: event.target.value }))} maxLength={2000} className="h-10 rounded border border-[#c8ced8] px-3" placeholder="Optional rationale for the decision" disabled={!entry.id} />
                    </label>
                  </div>

                  <details className="mt-4 rounded border border-[#d9dde5] p-3">
                    <summary className="cursor-pointer text-sm font-semibold">None of these? Search QuickBooks transactions</summary>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <input aria-label="Search QuickBooks transactions" value={entry.id ? transactionSearch[entry.id] ?? '' : ''} onChange={event => entry.id && setTransactionSearch(current => ({ ...current, [entry.id!]: event.target.value }))} className="h-10 min-w-64 flex-1 rounded border border-[#c8ced8] px-3" placeholder="Vendor, document number, amount, or transaction ID" disabled={!entry.id} />
                      <button type="button" disabled={!entry.id || searchingId === entry.id} onClick={() => void searchTransactions(entry)} className="h-10 rounded border border-[#c8ced8] px-4 text-sm font-semibold disabled:opacity-50">{searchingId === entry.id ? 'Searching…' : 'Search transactions'}</button>
                    </div>
                    {entry.id && transactionResults[entry.id] ? (
                      <ul className="mt-3 grid gap-2">
                        {filterQboTransactions(transactionResults[entry.id], transactionSearch[entry.id] ?? '').map(transaction => (
                          <li key={transaction.txnId}>
                            <button type="button" onClick={() => setSelectedTransactions(current => ({ ...current, [entry.id!]: transaction.txnId! }))} className={`w-full rounded border p-3 text-left text-sm ${selectedId === transaction.txnId ? 'border-[#315d83] bg-blue-50' : 'border-[#e3e7ed]'}`}>
                              <span className="font-semibold">{transaction.date || 'Date unknown'} · {transaction.txnType || 'Transaction'} · {transaction.docNumber || 'No document number'}</span>
                              <span className="block text-[#5d6675]">{transaction.vendor || 'Vendor unknown'} · {transaction.amount ?? 'Amount unknown'} · ID {transaction.txnId}</span>
                            </button>
                          </li>
                        ))}
                        {filterQboTransactions(transactionResults[entry.id], transactionSearch[entry.id] ?? '').length === 0 ? <li className="text-sm text-[#5d6675]">No transactions matched. Enter a search term to filter the date-range results.</li> : null}
                      </ul>
                    ) : null}
                  </details>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" disabled={!entry.id || savingId === entry.id || !selectedId} onClick={() => void submitDecision(entry, 'confirm_match')} className="h-10 rounded bg-[#243b53] px-4 text-sm font-semibold text-white disabled:opacity-50">{savingId === entry.id ? 'Saving…' : 'Approve document'}</button>
                    <button type="button" disabled={!entry.id || savingId === entry.id} onClick={() => void submitDecision(entry, 'reject_match')} className="h-10 rounded border border-[#c8ced8] px-4 text-sm font-semibold disabled:opacity-50">Reject match</button>
                    <button type="button" disabled={!entry.id || savingId === entry.id || !selectedId} onClick={() => void submitDecision(entry, 'mark_wrong_match')} className="h-10 rounded border border-amber-300 px-4 text-sm font-semibold text-amber-900 disabled:opacity-50">Mark wrong match</button>
                  </div>

                  {entry.reviewHistory?.length ? (
                    <details className="mt-4 border-t border-[#e3e7ed] pt-3 text-sm">
                      <summary className="cursor-pointer font-semibold">Decision history ({entry.reviewHistory.length})</summary>
                      <ol className="mt-2 grid gap-2">
                        {entry.reviewHistory.map(decision => <li key={decision.id} className="text-[#5d6675]">{decision.created_at} · {decision.action} · {decision.selected_qbo_txn_id || 'no transaction selected'}{decision.rationale ? ` · ${decision.rationale}` : ''}</li>)}
                      </ol>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
      </main>
    </div>
  );
}
