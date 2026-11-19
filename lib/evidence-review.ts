import type { RegisterEntry } from './qbo-evidence-register';

export type EvidenceReviewAction = 'confirm_match' | 'reject_match' | 'mark_wrong_match' | 'assign_transaction';

export interface EvidenceReviewDecision {
  id: string;
  realm_id: string;
  register_entry_id: string;
  evidence_document_id: string | null;
  reviewer_user_id: string | null;
  action: EvidenceReviewAction;
  selected_qbo_txn_id: string | null;
  rationale: string | null;
  created_at: string;
}

export interface EffectiveRegisterEntry extends RegisterEntry {
  humanApproved?: boolean;
  reviewDecision?: EvidenceReviewDecision;
  reviewHistory?: EvidenceReviewDecision[];
}

function registerIdentity(entry: RegisterEntry): string | null {
  if (entry.matchedDocumentId) return `document:${entry.matchedDocumentId}`;
  if (entry.qboTxnId && entry.attachableId) return `attachable:${entry.qboTxnId}:${entry.attachableId}`;
  if (entry.qboTxnId) return `transaction:${entry.qboTxnId}`;
  if (entry.attachableId) return `orphan:${entry.attachableId}`;
  return null;
}

/** Link freshly computed rows to their durable database IDs without changing persisted state. */
export function attachPersistedRegisterIds(
  computedEntries: RegisterEntry[],
  persistedEntries: RegisterEntry[],
): RegisterEntry[] {
  const persistedByIdentity = new Map<string, RegisterEntry[]>();
  for (const entry of persistedEntries) {
    const key = registerIdentity(entry);
    if (key) persistedByIdentity.set(key, [...(persistedByIdentity.get(key) ?? []), entry]);
  }

  const claimedIds = new Set<string>();
  return computedEntries.map((entry) => {
    if (entry.id) return entry;
    const matches = persistedByIdentity.get(registerIdentity(entry) ?? '') ?? [];
    const persisted = matches.find((candidate) => candidate.id && !claimedIds.has(candidate.id));
    if (!persisted?.id) return entry;
    claimedIds.add(persisted.id);
    return { ...entry, id: persisted.id };
  });
}

/** Apply the latest durable decision to each computed row and preserve one primary document per transaction. */
export function applyEvidenceReviewDecisions(
  entries: RegisterEntry[],
  decisions: EvidenceReviewDecision[],
): EffectiveRegisterEntry[] {
  const latestByEntry = new Map<string, EvidenceReviewDecision>();
  const historyByEntry = new Map<string, EvidenceReviewDecision[]>();
  const chronological = [...decisions].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
  for (const decision of chronological) {
    latestByEntry.set(decision.register_entry_id, decision);
    const keys = [decision.register_entry_id, decision.evidence_document_id ? `document:${decision.evidence_document_id}` : null].filter((key): key is string => !!key);
    for (const key of keys) historyByEntry.set(key, [...(historyByEntry.get(key) ?? []), decision]);
  }

  const effective = entries.map((entry): EffectiveRegisterEntry => {
    const stableKey = entry.matchedDocumentId ? `document:${entry.matchedDocumentId}` : null;
    const history = (stableKey ? historyByEntry.get(stableKey) : undefined) ?? (entry.id ? historyByEntry.get(entry.id) ?? (latestByEntry.get(entry.id) ? [latestByEntry.get(entry.id)!] : []) : []);
    const decision = history[history.length - 1];
    if (!decision) return { ...entry };

    const approved = decision.action === 'confirm_match' || decision.action === 'assign_transaction';
    if (approved) {
      const targetTxnId = decision.selected_qbo_txn_id ?? entry.qboTxnId;
      if (!targetTxnId) {
        return { ...entry, registerState: 'REVIEW_REQUIRED', humanApproved: false, reviewDecision: decision, reviewHistory: history };
      }
      return {
        ...entry,
        qboTxnId: targetTxnId,
        registerState: 'MATCHED',
        correctQboTxnId: null,
        reviewCandidateTxnIds: [],
        humanApproved: true,
        reviewDecision: decision,
        reviewHistory: history,
      };
    }

    if (decision.action === 'mark_wrong_match') {
      return {
        ...entry,
        registerState: 'WRONG_MATCHED',
        correctQboTxnId: decision.selected_qbo_txn_id,
        humanApproved: false,
        reviewDecision: decision,
        reviewHistory: history,
      };
    }

    return {
      ...entry,
      registerState: 'REVIEW_REQUIRED',
      reviewCandidateTxnIds: [...new Set([...entry.reviewCandidateTxnIds, ...(entry.qboTxnId ? [entry.qboTxnId] : [])])],
      humanApproved: false,
      reviewDecision: decision,
      reviewHistory: history,
    };
  });

  const initiallyMatched = new Set(effective.filter((entry, index) => entries[index].registerState === 'MATCHED'));
  const matchedByTransaction = new Map<string, EffectiveRegisterEntry>();
  for (const entry of effective) {
    if (entry.registerState !== 'MATCHED' || !entry.qboTxnId) continue;
    const existing = matchedByTransaction.get(entry.qboTxnId);
    if (!existing) {
      matchedByTransaction.set(entry.qboTxnId, entry);
      continue;
    }

    // Preserve the pre-existing primary document; if none exists, the earliest durable approval is primary.
    const currentRank = initiallyMatched.has(entry) ? 2 : entry.humanApproved ? 1 : 0;
    const existingRank = initiallyMatched.has(existing) ? 2 : existing.humanApproved ? 1 : 0;
    if (currentRank > existingRank) {
      existing.registerState = 'REVIEW_REQUIRED';
      existing.reviewCandidateTxnIds = [...new Set([...existing.reviewCandidateTxnIds, entry.qboTxnId])];
      matchedByTransaction.set(entry.qboTxnId, entry);
    } else {
      entry.registerState = 'REVIEW_REQUIRED';
      entry.reviewCandidateTxnIds = [...new Set([...entry.reviewCandidateTxnIds, entry.qboTxnId])];
    }
  }

  return effective;
}
