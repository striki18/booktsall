import { supabaseAdmin } from '@/lib/supabase-admin';
import type { RegisterEntry } from '@/lib/qbo-evidence-register';

type PackageEvidenceItem = {
  id: string;
  realm_id: string;
  register_entry_id: string | null;
  source_type: string;
  inbox_document_id: string | null;
  qbo_attachable_id: string | null;
  match_status: 'verified' | 'potential' | 'wrong_match' | 'duplicate' | 'unreviewed';
  review_status: 'not_required' | 'required' | 'approved' | 'discarded';
  evidence_role: 'primary' | 'additional' | 'unassigned';
  qbo_attachment_status: 'not_requested' | 'pending' | 'uploaded' | 'verified' | 'failed' | 'unknown';
};

type ItemReviewEvent = {
  id: string;
  evidence_item_id: string;
  reviewer_user_id: string | null;
  action: 'confirm_match' | 'approve_additional' | 'add_duplicate' | 'discard_additional' | 'discard_duplicate';
  selected_register_entry_id: string | null;
  rationale: string | null;
  created_at: string;
};

/** Add approved multi-document evidence rows without changing transaction or missing-register state. */
export async function addApprovedEvidenceItemsToPackage(entries: RegisterEntry[], realmId: string): Promise<RegisterEntry[]> {
  const registerRows = entries.filter((entry) => entry.id && entry.qboTxnId);
  if (!registerRows.length) return entries;
  const registerIds = [...new Set(registerRows.map((entry) => entry.id!))];

  const [additionalResult, primaryResult] = await Promise.all([
    supabaseAdmin.from('qbo_evidence_items')
      .select('id, realm_id, register_entry_id, source_type, inbox_document_id, qbo_attachable_id, match_status, review_status, evidence_role, qbo_attachment_status')
      .eq('realm_id', realmId).in('register_entry_id', registerIds)
      .eq('match_status', 'verified').eq('review_status', 'approved').eq('evidence_role', 'additional'),
    supabaseAdmin.from('qbo_evidence_items')
      .select('id, realm_id, register_entry_id, source_type, inbox_document_id, qbo_attachable_id, match_status, review_status, evidence_role, qbo_attachment_status')
      .eq('realm_id', realmId).in('register_entry_id', registerIds)
      .eq('match_status', 'verified').eq('review_status', 'not_required').eq('evidence_role', 'primary'),
  ]);
  if (additionalResult.error || primaryResult.error) throw new Error('Approved evidence items could not be loaded for the package');

  // Recomputed matches and legacy approvals must never undo a later discard.
  // Retain the register entry and its history, but exclude its bytes from download.
  const referencedDocumentIds = [...new Set([
    ...entries.flatMap(entry => entry.matchedDocumentId ? [entry.matchedDocumentId] : []),
    ...[...(additionalResult.data ?? []), ...(primaryResult.data ?? [])]
      .flatMap(item => item.inbox_document_id ? [item.inbox_document_id as string] : []),
  ])];
  const discardedDocumentIds = new Set<string>();
  for (let offset = 0; offset < referencedDocumentIds.length; offset += 200) {
    const { data, error } = await supabaseAdmin.from('qbo_evidence_items')
      .select('inbox_document_id').eq('realm_id', realmId).eq('review_status', 'discarded')
      .in('inbox_document_id', referencedDocumentIds.slice(offset, offset + 200));
    if (error) throw new Error('Discarded evidence could not be checked for the package');
    for (const item of data ?? []) if (item.inbox_document_id) discardedDocumentIds.add(item.inbox_document_id);
  }
  entries = entries.map(entry => entry.matchedDocumentId && discardedDocumentIds.has(entry.matchedDocumentId) ? {
    ...entry,
    evidenceReviewStatus: 'discarded' as const,
    humanApproved: false,
    registerState: entry.registerState === 'WRONG_MATCHED' ? 'WRONG_MATCHED' as const : 'REVIEW_REQUIRED' as const,
  } : entry);

  const itemsById = new Map<string, PackageEvidenceItem>();
  for (const item of [...(primaryResult.data ?? []), ...(additionalResult.data ?? [])] as PackageEvidenceItem[]) {
    if (item.realm_id === realmId && item.source_type === 'client_upload' && item.register_entry_id && item.inbox_document_id && !discardedDocumentIds.has(item.inbox_document_id)) {
      itemsById.set(item.id, item);
    }
  }
  const items = [...itemsById.values()];
  if (!items.length) return entries;

  const documentIds = [...new Set(items.map((item) => item.inbox_document_id!))];
  const { data: documents, error: documentsError } = await supabaseAdmin.from('inbox_documents')
    .select('id, realm_id, filename')
    .eq('realm_id', realmId).in('id', documentIds);
  if (documentsError) throw new Error('Approved evidence document metadata could not be loaded for the package');

  let events: ItemReviewEvent[] = [];
  if (items.length) {
    const { data, error } = await supabaseAdmin.from('qbo_evidence_item_review_events')
      .select('id, evidence_item_id, reviewer_user_id, action, selected_register_entry_id, rationale, created_at')
      .eq('realm_id', realmId).in('evidence_item_id', items.map((item) => item.id))
      .order('created_at', { ascending: true });
    if (error) throw new Error('Evidence review history could not be loaded for the package');
    events = (data ?? []) as ItemReviewEvent[];
  }

  const documentsById = new Map((documents ?? []).map((document) => [document.id, document]));
  const entriesById = new Map(registerRows.map((entry) => [entry.id!, entry]));
  const resultEntries = [...entries];
  const itemRows: RegisterEntry[] = [];

  for (const item of items) {
    const registerEntryId = item.register_entry_id;
    const inboxDocumentId = item.inbox_document_id;
    if (!registerEntryId || !inboxDocumentId) continue;
    const base = entriesById.get(registerEntryId);
    const document = documentsById.get(inboxDocumentId);
    if (!base) continue;
    if (document && document.realm_id !== realmId) continue;
    const provenWrongAssociation = item.qbo_attachable_id ? entries.find(row =>
      (row.qboTxnId ?? row.attachedQboTxnId ?? (row.reviewCandidateTxnIds.length === 1 ? row.reviewCandidateTxnIds[0] : null)) === base.qboTxnId &&
      row.attachableId === item.qbo_attachable_id && row.registerState === 'WRONG_MATCHED') : undefined;

    if (item.evidence_role === 'primary') {
      const primaryDecisionHistory = events.filter((event) => event.evidence_item_id === item.id);
      const isRegisterLinked = base.matchedDocumentId === inboxDocumentId;
      const confirmation = [...primaryDecisionHistory].reverse().find((event) =>
        event.action === 'confirm_match' && event.selected_register_entry_id === registerEntryId
      );
      const verifiedExistingPrimary = item.qbo_attachment_status === 'verified' &&
        Boolean(item.qbo_attachable_id) && !base.humanApproved && entries.some(row =>
          row.qboTxnId === base.qboTxnId && row.attachableId === item.qbo_attachable_id);
      if (!isRegisterLinked && !confirmation && !verifiedExistingPrimary) {
        throw new Error('Primary evidence without a register match is missing its immutable reviewer confirmation');
      }
      const history = primaryDecisionHistory.map((event) => ({
        id: event.id,
        realm_id: realmId,
        register_entry_id: registerEntryId,
        evidence_document_id: inboxDocumentId,
        reviewer_user_id: event.reviewer_user_id,
        action: event.action,
        selected_qbo_txn_id: event.selected_register_entry_id === registerEntryId ? base.qboTxnId : null,
        rationale: event.rationale,
        created_at: event.created_at,
      }));
      const combinedHistory = [...(base.reviewHistory ?? []), ...history];
      const primaryRow: RegisterEntry = {
        ...base,
        evidenceItemId: item.id,
        evidenceRole: item.evidence_role,
        evidenceReviewStatus: item.review_status,
        qboAttachmentStatus: item.qbo_attachment_status,
        matchedDocumentId: inboxDocumentId,
        attachmentFilename: document?.filename ?? base.attachmentFilename ?? 'unknown',
        attachableId: item.qbo_attachable_id ?? base.attachableId,
        registerState: provenWrongAssociation ? 'WRONG_MATCHED' : 'MATCHED',
        correctQboTxnId: provenWrongAssociation?.correctQboTxnId ?? null,
        matchFieldDetails: provenWrongAssociation?.matchFieldDetails ?? base.matchFieldDetails,
        humanApproved: Boolean(confirmation) || base.humanApproved,
        reviewDecision: combinedHistory[combinedHistory.length - 1] ?? base.reviewDecision,
        reviewHistory: combinedHistory.length ? combinedHistory : base.reviewHistory,
      };
      const existingDocumentIndex = resultEntries.findIndex((entry) => entry.matchedDocumentId === inboxDocumentId);
      if (existingDocumentIndex >= 0) {
        resultEntries[existingDocumentIndex] = {
          ...primaryRow,
          id: resultEntries[existingDocumentIndex].id ?? primaryRow.id,
        };
      } else if (base.registerState === 'MISSING' || base.registerState === 'REVIEW_REQUIRED') {
        const baseIndex = resultEntries.findIndex((entry) => entry.id === base.id);
        if (baseIndex >= 0) resultEntries[baseIndex] = primaryRow;
      } else {
        itemRows.push(primaryRow);
      }
      continue;
    }

    const itemEvents = events.filter((event) => event.evidence_item_id === item.id);
    const approval = [...itemEvents].reverse().find((event) =>
      (event.action === 'approve_additional' || event.action === 'add_duplicate') &&
      event.selected_register_entry_id === registerEntryId
    );
    if (!approval) throw new Error('Approved additional evidence is missing its matching immutable review event');

    const history = itemEvents.map((event) => ({
      id: event.id,
      realm_id: realmId,
      register_entry_id: registerEntryId,
      evidence_document_id: inboxDocumentId,
      reviewer_user_id: event.reviewer_user_id,
      action: event.action,
      selected_qbo_txn_id: event.selected_register_entry_id === registerEntryId ? base.qboTxnId : null,
      rationale: event.rationale,
      created_at: event.created_at,
    }));
    const combinedHistory = [...(base.reviewHistory ?? []), ...history];
    const latest = combinedHistory[combinedHistory.length - 1];
    const additionalRow: RegisterEntry = {
      ...base,
      evidenceItemId: item.id,
      evidenceRole: item.evidence_role,
      evidenceReviewStatus: item.review_status,
      qboAttachmentStatus: item.qbo_attachment_status,
      matchedDocumentId: inboxDocumentId,
      attachmentFilename: document?.filename ?? 'unknown',
      attachableId: item.qbo_attachable_id,
      registerState: provenWrongAssociation ? 'WRONG_MATCHED' : 'MATCHED',
      correctQboTxnId: provenWrongAssociation?.correctQboTxnId ?? null,
      matchFieldDetails: provenWrongAssociation?.matchFieldDetails ?? base.matchFieldDetails,
      humanApproved: true,
      reviewDecision: latest,
      reviewHistory: combinedHistory,
    };
    const existingDocumentIndex = resultEntries.findIndex((entry) => entry.matchedDocumentId === inboxDocumentId);
    if (existingDocumentIndex >= 0) {
      resultEntries[existingDocumentIndex] = {
        ...additionalRow,
        id: resultEntries[existingDocumentIndex].id ?? additionalRow.id,
      };
    } else {
      itemRows.push(additionalRow);
    }
  }

  const combined = [...resultEntries, ...itemRows];
  // The QBO relationship and its verified Zevidt item describe the same file.
  // Keep the canonical evidence row rather than downloading that file twice.
  return combined.filter(row => row.matchedDocumentId || !row.attachableId ||
    !combined.some(item => item.evidenceItemId && item.matchedDocumentId &&
      item.qboTxnId === row.qboTxnId && item.attachableId === row.attachableId));
}
