'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { filterQboTransactions } from '@/lib/transaction-search';
import { legacyReviewEntries } from '@/lib/evidence-register-view';
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
type EvidenceItem = {
  id: string;
  match_status: string;
  evidence_role: string;
  qbo_attachment_status: string;
  qbo_attachable_id: string | null;
  candidate_qbo_txn_ids: string[];
  register_entry_id: string | null;
  proposed_register_entry_id?: string | null;
  document: { filename: string; content_type: string; file_size: number } | null;
  duplicateOf: { register_entry_id: string | null; proposed_register_entry_id?: string | null; candidate_qbo_txn_ids: string[] } | null;
  transactionChoices: Array<{ id: string; qbo_txn_id: string | null; qbo_txn_type: string | null; qbo_txn_date: string | null; qbo_txn_vendor: string | null; qbo_txn_amount: number | null; qbo_txn_doc_number: string | null }>;
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
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItem[]>([]);
  const [managedDocumentIds, setManagedDocumentIds] = useState<string[] | null>(null);
  const [evidenceItemError, setEvidenceItemError] = useState<string | null>(null);
  const [evidenceItemActionId, setEvidenceItemActionId] = useState<string | null>(null);
  const [evidenceItemTransactions, setEvidenceItemTransactions] = useState<Record<string, string>>({});
  const [evidenceItemSearchOpen, setEvidenceItemSearchOpen] = useState<Record<string, boolean>>({});
  const [evidenceItemSearch, setEvidenceItemSearch] = useState<Record<string, string>>({});
  const [selectedReviewItemId, setSelectedReviewItemId] = useState<string | null>(null);

  useEffect(() => {
    if (evidenceItems.length === 0) {
      setSelectedReviewItemId(null);
      return;
    }
    if (!selectedReviewItemId || !evidenceItems.some(item => item.id === selectedReviewItemId)) setSelectedReviewItemId(evidenceItems[0].id);
  }, [evidenceItems, selectedReviewItemId]);

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
      try {
        const [itemResponse, managedResponse] = await Promise.all([
          fetch('/api/evidence/items'), fetch('/api/evidence/items?managedDocuments=true'),
        ]);
        const [itemBody, managedBody] = await Promise.all([itemResponse.json(), managedResponse.json()]);
        if (!itemResponse.ok) throw new Error(itemBody.error || 'Unable to load evidence items');
        if (!Array.isArray(itemBody)) throw new Error('Evidence item response was invalid');
        if (!managedResponse.ok || !Array.isArray(managedBody.documentIds) || managedBody.documentIds.some((id: unknown) => typeof id !== 'string')) throw new Error('Unable to verify document review ownership');
        setEvidenceItems(itemBody);
        setManagedDocumentIds(managedBody.documentIds);
        setEvidenceItemError(null);
      } catch (itemCause) {
        setManagedDocumentIds(null);
        setEvidenceItems([]);
        setEvidenceItemError(itemCause instanceof Error ? itemCause.message : 'Unable to load evidence items');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load evidence register');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  async function reviewEvidenceItem(item: EvidenceItem, action: 'confirm_match' | 'approve_additional' | 'add_duplicate' | 'discard_additional' | 'discard_duplicate') {
    const selectedRegisterEntryId = evidenceItemTransactions[item.id] || item.register_entry_id || item.proposed_register_entry_id || item.duplicateOf?.register_entry_id || item.duplicateOf?.proposed_register_entry_id || '';
    if ((action === 'add_duplicate' || action === 'confirm_match') && !selectedRegisterEntryId) {
      setError('Choose the QuickBooks transaction before confirming this decision.');
      return;
    }
    const choice = item.transactionChoices.find(transaction => transaction.id === selectedRegisterEntryId);
    const registerEntry = entries.find(entry => entry.id === selectedRegisterEntryId);
    const transactionLabel = [
      choice?.qbo_txn_type ?? registerEntry?.qboTxnType,
      choice?.qbo_txn_doc_number ?? registerEntry?.qboTxnDocNumber,
      choice?.qbo_txn_id ?? registerEntry?.qboTxnId,
      choice?.qbo_txn_vendor ?? registerEntry?.qboTxnVendor,
      choice?.qbo_txn_date ?? registerEntry?.qboTxnDate,
      choice?.qbo_txn_amount ?? registerEntry?.qboTxnAmount,
    ].filter(value => value !== null && value !== undefined && value !== '').join(' · ');
    if (!action.startsWith('discard') && !transactionLabel) {
      setError('Refresh the register and choose a transaction whose details are available.');
      return;
    }
    const documentLabel = item.document?.filename || `QBO attachment ${item.qbo_attachable_id || item.id}`;
    const confirmation = action.startsWith('discard')
      ? `Discard "${documentLabel}" from the active review queue? Its file and review history will be retained.`
      : action === 'confirm_match'
        ? `Confirm "${documentLabel}" matches ${transactionLabel}? If this is the first evidence, Zevidt will attach it to QuickBooks and verify the association. Existing evidence requires an additional approval.`
        : `Approve "${documentLabel}" for ${transactionLabel}? Zevidt will attach it to QuickBooks and verify the association, or reuse an existing identical attachment.`;
    if (!window.confirm(confirmation)) return;

    setEvidenceItemActionId(item.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/evidence/items/${encodeURIComponent(item.id)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, finalConfirmation: true, registerEntryId: selectedRegisterEntryId || undefined }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.decisionRecorded) await loadRegister();
        throw new Error(body.error || 'The review decision could not be completed');
      }
      if (action.startsWith('discard')) {
        setNotice('Discarded from the active queue. The document and audit history remain stored in Zevidt.');
      } else if (body.requiresAdditionalApproval) {
        setNotice('Match confirmed. This transaction already has evidence, so the document remains in review and was not attached to QuickBooks.');
      } else if (body.attachment?.status === 'verified') {
        setNotice('Decision recorded. QuickBooks attachment was read back and verified.');
      } else {
        throw new Error(body.error || 'Decision was recorded, but the QuickBooks attachment is not verified.');
      }
      await loadRegister();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save the evidence decision');
    } finally {
      setEvidenceItemActionId(null);
    }
  }

  // The async loader updates state after its network requests complete.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadRegister(); }, [loadRegister]);

  const reviewEntries = useMemo(
    () => legacyReviewEntries(entries, managedDocumentIds),
    [entries, managedDocumentIds],
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
          <button disabled={loading} className="h-11 rounded-lg bg-[#3e6ae1] px-4 font-semibold text-white shadow-sm hover:bg-[#3159c9] disabled:opacity-60">{loading ? 'Loading…' : 'Refresh register'}</button>
          <span className="ml-auto text-sm text-[#5d6675]">{reviewEntries.length + evidenceItems.length} item{reviewEntries.length + evidenceItems.length === 1 ? '' : 's'} to review</span>
        </form>

        {error ? <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        {notice ? <p role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p> : null}

        <section className="mb-8" aria-labelledby="evidence-item-review-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="evidence-item-review-heading" className="text-xl font-semibold">Documents needing a decision</h2>
              <p className="mt-1 text-sm text-[#5d6675]">Approve additional evidence only after checking it. Discard keeps the file and decision history in Zevidt.</p>
            </div>
            <span className="text-sm text-[#5d6675]">{evidenceItems.length} item{evidenceItems.length === 1 ? '' : 's'}</span>
          </div>
          {evidenceItemError ? <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{evidenceItemError}</p> : null}
          {!evidenceItemError && evidenceItems.length === 0 ? <p className="rounded-lg border border-[#d9dde5] bg-white p-5 text-sm text-[#5d6675]">No document-level decisions are waiting.</p> : null}
          <div className="reviewWorkbench">
            <aside className="reviewQueue" aria-label="Review queue">
              {evidenceItems.map(item => {
                const isDuplicate = item.match_status === 'duplicate';
                const isPotential = item.match_status === 'potential';
                return <button key={item.id} type="button" className={selectedReviewItemId === item.id ? 'isSelected' : ''} onClick={() => setSelectedReviewItemId(item.id)}>
                  <span>{isDuplicate ? 'Duplicate' : isPotential ? 'Potential match' : 'Additional'}</span>
                  <strong>{item.document?.filename || 'QuickBooks attachment'}</strong>
                  <small>{item.qbo_attachment_status.replace('_', ' ')}</small>
                </button>;
              })}
            </aside>
            <div className="reviewDetail">
            {evidenceItems.filter(item => item.id === selectedReviewItemId).map(item => {
              const choices = item.transactionChoices ?? [];
              const selectedRegisterEntryId = evidenceItemTransactions[item.id] || item.register_entry_id || item.proposed_register_entry_id || item.duplicateOf?.register_entry_id || item.duplicateOf?.proposed_register_entry_id || '';
              const isDuplicate = item.match_status === 'duplicate';
              const isPotential = item.match_status === 'potential';
              const selectedRegisterEntry = entries.find(entry => entry.id === selectedRegisterEntryId && entry.qboTxnId);
              const linkedTransaction = choices.find(choice => choice.id === selectedRegisterEntryId) ?? (selectedRegisterEntry ? {
                id: selectedRegisterEntry.id!,
                qbo_txn_id: selectedRegisterEntry.qboTxnId,
                qbo_txn_type: selectedRegisterEntry.qboTxnType,
                qbo_txn_date: selectedRegisterEntry.qboTxnDate,
                qbo_txn_doc_number: selectedRegisterEntry.qboTxnDocNumber,
                qbo_txn_vendor: selectedRegisterEntry.qboTxnVendor,
                qbo_txn_amount: selectedRegisterEntry.qboTxnAmount,
              } : undefined);
              const searchOpen = evidenceItemSearchOpen[item.id] ?? false;
              const searchText = evidenceItemSearch[item.id] ?? '';
              const registerSearchResults = filterQboTransactions(entries
                .filter(entry => !!entry.id && !!entry.qboTxnId)
                .map(entry => ({
                  registerEntryId: entry.id!, txnId: entry.qboTxnId!, txnType: entry.qboTxnType,
                  date: entry.qboTxnDate, vendor: entry.qboTxnVendor,
                  amount: entry.qboTxnAmount, docNumber: entry.qboTxnDocNumber,
                })), searchText);
              return (
                <article key={item.id} className="reviewDecisionCard rounded-lg border border-[#d9dde5] bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#65758b]">{isDuplicate ? 'Duplicate found' : isPotential ? 'Potential match' : 'Additional evidence'} · review required</p>
                      <h3 className="mt-1 font-semibold">{item.document?.filename || 'QuickBooks attachment'}</h3>
                      <p className="mt-1 text-sm text-[#5d6675]">{item.document ? `${item.document.content_type} · ${item.document.file_size} bytes` : `QBO attachment ID ${item.qbo_attachable_id || 'unavailable'}`} · {item.qbo_attachment_status.replace('_', ' ')}</p>
                      {linkedTransaction ? <p className="mt-1 text-sm text-[#5d6675]">{linkedTransaction.qbo_txn_date || 'Date unknown'} · {linkedTransaction.qbo_txn_type || 'Transaction'} · {linkedTransaction.qbo_txn_doc_number || linkedTransaction.qbo_txn_id || 'Reference unavailable'} · {linkedTransaction.qbo_txn_vendor || 'Vendor unknown'} · {linkedTransaction.qbo_txn_amount ?? 'Amount unknown'}</p> : null}
                    </div>
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">{isDuplicate ? 'Duplicate' : 'Additional'}</span>
                  </div>
                  {isDuplicate || isPotential ? (
                    <label className="mt-4 grid max-w-2xl gap-1 text-sm font-medium">{isPotential ? 'Confirm the suggested transaction' : 'Transaction for approved duplicate'}
                      <select value={selectedRegisterEntryId} onChange={event => setEvidenceItemTransactions(current => ({ ...current, [item.id]: event.target.value }))} className="h-10 rounded border border-[#c8ced8] bg-white px-3">
                        <option value="">Choose a transaction</option>
                        {linkedTransaction && !choices.some(choice => choice.id === linkedTransaction.id) ? <option value={linkedTransaction.id}>{linkedTransaction.qbo_txn_date || 'Date unknown'} · {linkedTransaction.qbo_txn_type || 'Transaction'} · {linkedTransaction.qbo_txn_doc_number || linkedTransaction.qbo_txn_id} · {linkedTransaction.qbo_txn_vendor || 'Vendor unknown'} · {linkedTransaction.qbo_txn_amount ?? 'Amount unknown'}</option> : null}
                        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.qbo_txn_date || 'Date unknown'} · {choice.qbo_txn_type || 'Transaction'} · {choice.qbo_txn_doc_number || choice.qbo_txn_id || choice.id} · {choice.qbo_txn_vendor || 'Vendor unknown'} · {choice.qbo_txn_amount ?? 'Amount unknown'}</option>)}
                      </select>
                      <button type="button" onClick={() => setEvidenceItemSearchOpen(current => ({ ...current, [item.id]: !searchOpen }))} className="mt-2 w-fit text-sm font-semibold text-[#176b52]">
                        {searchOpen ? 'Close transaction search' : 'None of these? Search loaded transactions'}
                      </button>
                    </label>
                  ) : null}
                  {searchOpen ? (
                    <div className="mt-3 grid max-w-2xl gap-2 rounded border border-[#d9dde5] bg-[#f8faf8] p-3">
                      <label className="grid gap-1 text-sm font-medium">Search transactions already loaded in this company’s register
                        <input value={searchText} onChange={event => setEvidenceItemSearch(current => ({ ...current, [item.id]: event.target.value }))} className="h-10 rounded border border-[#c8ced8] bg-white px-3" placeholder="Vendor, document number, amount, or transaction ID" />
                      </label>
                      <ul className="grid gap-1">
                        {registerSearchResults.filter(result => !choices.some(choice => choice.id === result.registerEntryId)).map(result => (
                          <li key={result.registerEntryId}>
                            <button type="button" onClick={() => {
                              setEvidenceItemTransactions(current => ({ ...current, [item.id]: result.registerEntryId }));
                              setEvidenceItemSearchOpen(current => ({ ...current, [item.id]: false }));
                            }} className="w-full rounded border border-[#e2e7e3] bg-white p-2 text-left text-sm hover:bg-[#f0f7f2]">
                              {result.date || 'Date unknown'} · {result.txnType || 'Transaction'} · {result.docNumber || result.txnId} · {result.vendor || 'Name unknown'} · {result.amount ?? 'Amount unknown'}
                            </button>
                          </li>
                        ))}
                        {searchText.trim() && registerSearchResults.filter(result => !choices.some(choice => choice.id === result.registerEntryId)).length === 0 ? <li className="text-sm text-[#5d6675]">No other transactions match in the loaded register. Expand the review date range and refresh to load more.</li> : null}
                        {!searchText.trim() ? <li className="text-sm text-[#5d6675]">Enter a search term to find other transactions in the current review date range.</li> : null}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" disabled={evidenceItemActionId === item.id || ((isDuplicate || isPotential) && !selectedRegisterEntryId)} onClick={() => void reviewEvidenceItem(item, isDuplicate ? 'add_duplicate' : isPotential ? 'confirm_match' : 'approve_additional')} className="h-11 rounded-lg bg-[#3e6ae1] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#3159c9] disabled:opacity-50">{evidenceItemActionId === item.id ? 'Saving…' : isDuplicate ? 'Add to QuickBooks' : isPotential ? 'Confirm match' : 'Approve and attach'}</button>
                    {!isPotential ? <button type="button" disabled={evidenceItemActionId === item.id} onClick={() => void reviewEvidenceItem(item, isDuplicate ? 'discard_duplicate' : 'discard_additional')} className="h-10 rounded border border-[#c8ced8] px-4 text-sm font-semibold disabled:opacity-50">Discard from review</button> : null}
                  </div>
                </article>
              );
            })}
            </div>
          </div>
        </section>

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
                    <button type="button" disabled={!entry.id || savingId === entry.id || !selectedId} onClick={() => void submitDecision(entry, 'confirm_match')} className="h-11 rounded-lg bg-[#3e6ae1] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#3159c9] disabled:opacity-50">{savingId === entry.id ? 'Saving…' : 'Approve document'}</button>
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
