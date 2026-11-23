import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { downloadAttachableBytes, getAttachableById, getAttachables, getAttachablesForTransaction, getTransactionById, normalizeAttachables, uploadAttachable } from '@/lib/quickbooks';
import { validateEvidenceFile } from '@/lib/upload-validation';
import { qboTransactionEntityType } from '@/lib/qbo-transaction-types';

type EventType =
  | 'preflight_blocked'
  | 'attempt_started'
  | 'upload_succeeded'
  | 'upload_failed'
  | 'outcome_unknown'
  | 'verification_succeeded'
  | 'verification_failed';

const APPROVED_SANDBOX_REALM_ID = '9341458707866620';

export class QboAttachmentWorkflowError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'QboAttachmentWorkflowError';
  }
}

/** Reconcile an ambiguous attempt by reading QBO only. Never sends an upload. */
export async function reconcileQboAttachment(input: {
  realmId: string; evidenceItemId: string; attachableId: string; actorUserId: string | null;
}) {
  if (input.realmId !== APPROVED_SANDBOX_REALM_ID || process.env.INTUIT_REALM_ID !== input.realmId || !/^\d+$/.test(input.attachableId)) {
    throw new QboAttachmentWorkflowError('Invalid sandbox reconciliation target', 403);
  }
  const { data: item, error } = await supabaseAdmin.from('qbo_evidence_items')
    .select('id, register_entry_id, content_sha256, qbo_attachment_status, qbo_attachable_id')
    .eq('realm_id', input.realmId).eq('id', input.evidenceItemId).maybeSingle();
  if (error || !item || !/^[a-f0-9]{64}$/.test(item.content_sha256 ?? '')) {
    throw new QboAttachmentWorkflowError('Evidence identity could not be verified', 409);
  }
  if (item.qbo_attachment_status !== 'unknown' || item.qbo_attachable_id) {
    throw new QboAttachmentWorkflowError('Only an unresolved attachment can be reconciled', 409);
  }
  const { data: attempt, error: attemptError } = await supabaseAdmin.from('qbo_attachment_events')
    .select('attempt_id, qbo_txn_id, qbo_txn_type').eq('realm_id', input.realmId)
    .eq('evidence_item_id', item.id).eq('event_type', 'attempt_started').maybeSingle();
  const { data: register, error: registerError } = await supabaseAdmin.from('qbo_evidence_register')
    .select('qbo_txn_id, qbo_txn_type').eq('realm_id', input.realmId)
    .eq('id', item.register_entry_id).maybeSingle();
  if (attemptError || registerError || !attempt || !register ||
      attempt.qbo_txn_id !== register.qbo_txn_id || attempt.qbo_txn_type !== qboTransactionEntityType(register.qbo_txn_type ?? '')) {
    throw new QboAttachmentWorkflowError('Original attachment target could not be verified', 409);
  }
  const metadata = await getAttachables(input.realmId);
  const associated = normalizeAttachables(metadata.attachables).some((a) =>
    String(a.attachableId) === input.attachableId && String(a.entityId) === attempt.qbo_txn_id &&
    String(a.entityType).toLowerCase() === attempt.qbo_txn_type.toLowerCase());
  if (!associated) throw new QboAttachmentWorkflowError('Attachment is not linked to the original transaction', 409);
  const downloaded = await downloadAttachableBytes(input.attachableId, input.realmId);
  if (createHash('sha256').update(downloaded.bytes).digest('hex') !== item.content_sha256) {
    throw new QboAttachmentWorkflowError('Attachment bytes do not match the evidence item', 409);
  }
  // Preserve the original unknown event. A unique result event makes concurrent
  // reconciliation fail closed rather than creating another attempt.
  await appendEvent({ realmId: input.realmId, evidenceItemId: item.id, attemptId: attempt.attempt_id,
    eventType: 'verification_succeeded', qboTxnId: attempt.qbo_txn_id, qboTxnType: attempt.qbo_txn_type,
    qboAttachableId: input.attachableId, actorUserId: input.actorUserId, httpStatus: downloaded.httpStatus,
    details: { reconciled: true, association_verified: true, content_sha256_verified: true } });
  const { data: updated, error: updateError } = await supabaseAdmin.from('qbo_evidence_items')
    .update({ qbo_attachment_status: 'verified', qbo_attachable_id: input.attachableId })
    .eq('realm_id', input.realmId).eq('id', item.id).eq('qbo_attachment_status', 'unknown')
    .select('id').maybeSingle();
  if (updateError || !updated) throw new QboAttachmentWorkflowError('Verification recorded; item status needs reconciliation', 503);
  return { evidenceItemId: item.id, qboAttachableId: input.attachableId, status: 'verified' as const };
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

function blocksFirstEvidence(related: { id: string; evidence_role?: string; review_status?: string; qbo_attachment_status?: string }, currentId: string): boolean {
  if (related.id === currentId) return false;
  // The database has already awarded the unique primary slot. A concurrently
  // arriving, unapproved additional item must not cancel that winner.
  return !(related.evidence_role === 'additional' && related.review_status === 'required' && related.qbo_attachment_status === 'not_requested');
}

async function appendEvent(input: {
  realmId: string;
  evidenceItemId: string;
  attemptId: string;
  eventType: EventType;
  qboTxnType: string;
  qboTxnId: string;
  qboAttachableId?: string | null;
  httpStatus?: number | null;
  details?: Record<string, unknown>;
  actorUserId: string | null;
}) {
  const { error } = await supabaseAdmin.from('qbo_attachment_events').insert({
    realm_id: input.realmId,
    evidence_item_id: input.evidenceItemId,
    attempt_id: input.attemptId,
    event_type: input.eventType,
    qbo_txn_type: input.qboTxnType,
    qbo_txn_id: input.qboTxnId,
    qbo_attachable_id: input.qboAttachableId ?? null,
    http_status: input.httpStatus ?? null,
    details: input.details ?? {},
    actor_user_id: input.actorUserId,
  });
  if (error) throw new QboAttachmentWorkflowError('Could not persist the attachment audit event', 503);
}

function linkedToTransaction(attachables: unknown[], qboTxnType: string, qboTxnId: string) {
  return normalizeAttachables(attachables).some((attachable) =>
    String(attachable.entityId ?? '') === qboTxnId &&
    String(attachable.entityType ?? '').toLowerCase() === qboTxnType.toLowerCase()
  );
}

async function findExactTransactionAttachment(
  attachables: unknown[],
  qboTxnType: string,
  qboTxnId: string,
  realmId: string,
  contentHash: string,
) {
  const related = normalizeAttachables(attachables).filter((attachable) =>
    String(attachable.entityId ?? '') === qboTxnId &&
    String(attachable.entityType ?? '').toLowerCase() === qboTxnType.toLowerCase()
  );
  for (const attachable of related) {
    const attachableId = String(attachable.attachableId ?? '');
    if (!/^\d+$/.test(attachableId)) {
      throw new QboAttachmentWorkflowError('An existing transaction attachment could not be identified safely', 503);
    }
    let downloaded: Awaited<ReturnType<typeof downloadAttachableBytes>>;
    try {
      downloaded = await downloadAttachableBytes(attachableId, realmId);
    } catch {
      // Do not upload when an existing attachment cannot be checked for identical bytes.
      throw new QboAttachmentWorkflowError('Existing QuickBooks evidence could not be checked for an exact duplicate', 503);
    }
    if (createHash('sha256').update(downloaded.bytes).digest('hex') === contentHash) {
      return { attachableId, httpStatus: downloaded.httpStatus };
    }
  }
  return null;
}

async function linkExactDuplicate(input: {
  realmId: string;
  evidenceItemId: string;
  attemptId: string;
  actorUserId: string | null;
  qboTxnType: string;
  qboTxnId: string;
  contentHash: string;
  attachableId: string;
  httpStatus: number;
  expectedStatus: 'not_requested' | 'pending';
}) {
  const { data: existingItem, error: existingError } = await supabaseAdmin.from('qbo_evidence_items')
    .select('id')
    .eq('realm_id', input.realmId)
    .eq('qbo_attachable_id', input.attachableId)
    .maybeSingle();
  if (existingError) throw new QboAttachmentWorkflowError('Could not link the existing QuickBooks attachment', 503);
  if (existingItem?.id === input.evidenceItemId) {
    throw new QboAttachmentWorkflowError('The evidence item is already linked to this QuickBooks attachment', 409);
  }

  await appendEvent({
    realmId: input.realmId,
    evidenceItemId: input.evidenceItemId,
    attemptId: input.attemptId,
    eventType: 'preflight_blocked',
    qboTxnType: input.qboTxnType,
    qboTxnId: input.qboTxnId,
    qboAttachableId: input.attachableId,
    httpStatus: input.httpStatus,
    actorUserId: input.actorUserId,
    details: { reason: 'exact_duplicate_linked', content_sha256: input.contentHash },
  });
  const { data: updated, error: updateError } = await supabaseAdmin.from('qbo_evidence_items')
    .update({
      qbo_attachment_status: 'verified',
      qbo_attachable_id: existingItem ? null : input.attachableId,
      duplicate_of_item_id: existingItem?.id ?? null,
    })
    .eq('realm_id', input.realmId)
    .eq('id', input.evidenceItemId)
    .eq('qbo_attachment_status', input.expectedStatus)
    .select('id')
    .maybeSingle();
  if (updateError || !updated) throw new QboAttachmentWorkflowError('Exact duplicate was found but its Zevidt link could not be recorded', 503);
  return { evidenceItemId: input.evidenceItemId, qboTxnId: input.qboTxnId, qboAttachableId: input.attachableId, status: 'verified' as const, duplicate: true as const };
}

async function markAdditionalForReview(realmId: string, evidenceItemId: string, expectedStatus: 'not_requested' | 'pending' = 'not_requested') {
  const { data, error } = await supabaseAdmin.from('qbo_evidence_items')
    .update({ evidence_role: 'additional', review_status: 'required' })
    .eq('realm_id', realmId)
    .eq('id', evidenceItemId)
    .eq('qbo_attachment_status', expectedStatus)
    .select('id')
    .maybeSingle();
  if (error || !data) throw new QboAttachmentWorkflowError('Evidence was blocked from upload but could not be moved to review', 503);
}

/**
 * Attach eligible evidence exactly once. First evidence requires machine verification;
 * additional evidence requires an immutable, recorded human approval. Every write is
 * preceded by an immutable claim event; the database's partial unique index
 * makes concurrent requests mutually exclusive. Ambiguous outcomes are never
 * retried by this workflow.
 */
export async function uploadFirstEvidenceItemToQbo(input: {
  evidenceItemId: string;
  realmId: string;
  actorUserId: string | null;
}) {
  const expectedRealmId = process.env.INTUIT_REALM_ID;
  if (
    input.realmId !== APPROVED_SANDBOX_REALM_ID ||
    expectedRealmId !== APPROVED_SANDBOX_REALM_ID
  ) {
    throw new QboAttachmentWorkflowError('The connected QuickBooks company does not match the configured sandbox', 403);
  }

  const { data: item, error: itemError } = await supabaseAdmin.from('qbo_evidence_items')
    .select('id, realm_id, register_entry_id, source_type, inbox_document_id, content_sha256, match_status, review_status, evidence_role, qbo_attachment_status, qbo_attachable_id')
    .eq('realm_id', input.realmId)
    .eq('id', input.evidenceItemId)
    .maybeSingle();
  if (itemError) throw new QboAttachmentWorkflowError('Could not verify the evidence item', 503);
  if (!item) throw new QboAttachmentWorkflowError('Evidence item not found', 404);
  const isFirstEvidence = item.evidence_role === 'primary' && item.review_status === 'not_required';
  const isApprovedAdditional = item.evidence_role === 'additional' && item.review_status === 'approved';
  if (
    item.source_type !== 'client_upload' ||
    item.match_status !== 'verified' ||
    (!isFirstEvidence && !isApprovedAdditional) ||
    item.qbo_attachment_status !== 'not_requested' ||
    item.qbo_attachable_id ||
    !item.register_entry_id ||
    !item.inbox_document_id
  ) {
    throw new QboAttachmentWorkflowError('Evidence is not eligible for a new QuickBooks attachment', 409);
  }
  let reviewAuthorization: { id: string; action: string; selected_register_entry_id: string | null } | null = null;
  if (isApprovedAdditional || isFirstEvidence) {
    const reviewQuery = supabaseAdmin.from('qbo_evidence_item_review_events')
      .select('id, action, selected_register_entry_id')
      .eq('realm_id', input.realmId)
      .eq('evidence_item_id', item.id)
      .eq('selected_register_entry_id', item.register_entry_id);
    const { data: reviewEvent, error: approvalError } = await (isApprovedAdditional
      ? reviewQuery.in('action', ['approve_additional', 'add_duplicate'])
      : reviewQuery.eq('action', 'confirm_match'))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (approvalError) throw new QboAttachmentWorkflowError('Evidence review authorization could not be verified', 409);
    reviewAuthorization = reviewEvent;
    if (isApprovedAdditional && !reviewAuthorization) throw new QboAttachmentWorkflowError('Human approval could not be verified', 409);
    if (isFirstEvidence && reviewAuthorization && reviewAuthorization.action !== 'confirm_match') {
      throw new QboAttachmentWorkflowError('The transaction confirmation could not be verified', 409);
    }
  }

  const [{ data: register, error: registerError }, { data: document, error: documentError }] = await Promise.all([
    supabaseAdmin.from('qbo_evidence_register')
      .select('id, realm_id, qbo_txn_id, qbo_txn_type, register_state, matched_document_id')
      .eq('realm_id', input.realmId)
      .eq('id', item.register_entry_id)
      .maybeSingle(),
    supabaseAdmin.from('inbox_documents')
      .select('id, realm_id, storage_path, filename, content_type, file_size')
      .eq('realm_id', input.realmId)
      .eq('id', item.inbox_document_id)
      .maybeSingle(),
  ]);
  if (registerError || documentError) throw new QboAttachmentWorkflowError('Could not verify the evidence source and transaction', 503);
  if (!register || !document || register.realm_id !== input.realmId || document.realm_id !== input.realmId) {
    throw new QboAttachmentWorkflowError('Evidence source or transaction is unavailable for this company', 404);
  }
  const qboTxnId = String(register.qbo_txn_id ?? '');
  const qboTxnType = qboTransactionEntityType(String(register.qbo_txn_type ?? ''));
  if (!qboTxnType) throw new QboAttachmentWorkflowError('This transaction type requires manual verification before attachment', 409);
  const persistedRegisterMatch = register.register_state === 'MATCHED' && register.matched_document_id === document.id;
  const reviewerConfirmedItemMatch = Boolean(
    reviewAuthorization &&
    reviewAuthorization.selected_register_entry_id === register.id &&
    ((isFirstEvidence && reviewAuthorization.action === 'confirm_match') ||
      (isApprovedAdditional && ['approve_additional', 'add_duplicate'].includes(reviewAuthorization.action)))
  );
  if ((!persistedRegisterMatch && !reviewerConfirmedItemMatch) || !qboTxnId || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(qboTxnType)) {
    throw new QboAttachmentWorkflowError('The evidence item is not linked to a confirmed QuickBooks transaction', 409);
  }

  const { data: relatedItems, error: relatedError } = await supabaseAdmin.from('qbo_evidence_items')
    .select('id, evidence_role, review_status, qbo_attachment_status')
    .eq('realm_id', input.realmId)
    .eq('register_entry_id', register.id);
  if (relatedError) throw new QboAttachmentWorkflowError('Could not check for existing Zevidt evidence', 503);
  if (!isApprovedAdditional && (relatedItems ?? []).some((related) => blocksFirstEvidence(related, item.id))) {
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId: randomUUID(),
      eventType: 'preflight_blocked', qboTxnType, qboTxnId, actorUserId: input.actorUserId,
      details: { reason: 'existing_zevidt_evidence' },
    });
    await markAdditionalForReview(input.realmId, item.id);
    throw new QboAttachmentWorkflowError('Other Zevidt evidence already exists; human review is required', 409);
  }

  const { data: storedFile, error: storageError } = await supabaseAdmin.storage.from('evidence').download(document.storage_path);
  if (storageError || !storedFile) throw new QboAttachmentWorkflowError('Could not retrieve the stored evidence file', 503);
  const fileBytes = Buffer.from(await storedFile.arrayBuffer());
  const file = new File([fileBytes], document.filename, { type: document.content_type });
  const validation = await validateEvidenceFile(file);
  if (!validation.valid || validation.contentType !== document.content_type || fileBytes.length !== Number(document.file_size)) {
    throw new QboAttachmentWorkflowError('Stored evidence file failed integrity or type validation', 409);
  }
  const contentHash = createHash('sha256').update(fileBytes).digest('hex');
  if (!item.content_sha256 || item.content_sha256 !== contentHash) {
    throw new QboAttachmentWorkflowError('Stored evidence file does not match its verified content hash', 409);
  }

  let firstTransactionCheck: Awaited<ReturnType<typeof getTransactionById>>;
  let firstCheck: Awaited<ReturnType<typeof getAttachables>>;
  try {
    [firstTransactionCheck, firstCheck] = await Promise.all([
      getTransactionById(qboTxnType, qboTxnId, input.realmId),
      getAttachables(input.realmId),
    ]);
  } catch {
    throw new QboAttachmentWorkflowError('QuickBooks transaction and attachment preflight could not be completed', 503);
  }
  if (!firstTransactionCheck.transaction) {
    throw new QboAttachmentWorkflowError('The registered transaction could not be found in the authorized QuickBooks company', 409);
  }
  if (linkedToTransaction(firstCheck.attachables, qboTxnType, qboTxnId) && !isApprovedAdditional) {
    const attemptId = randomUUID();
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType: 'preflight_blocked', qboTxnType, qboTxnId, actorUserId: input.actorUserId,
      httpStatus: firstCheck.httpStatus, details: { reason: 'existing_qbo_attachment' },
    });
    await markAdditionalForReview(input.realmId, item.id);
    throw new QboAttachmentWorkflowError('QuickBooks already has evidence for this transaction; human review is required', 409);
  }

  if (isApprovedAdditional && linkedToTransaction(firstCheck.attachables, qboTxnType, qboTxnId)) {
    const exact = await findExactTransactionAttachment(firstCheck.attachables, qboTxnType, qboTxnId, input.realmId, contentHash);
    if (exact) {
      return linkExactDuplicate({
        realmId: input.realmId, evidenceItemId: item.id, attemptId: randomUUID(), actorUserId: input.actorUserId,
        qboTxnType, qboTxnId, contentHash, attachableId: exact.attachableId,
        httpStatus: exact.httpStatus, expectedStatus: 'not_requested',
      });
    }
  }

  // A matching file on another transaction must be linked, never re-uploaded.
  // Fail closed until the cross-transaction linking operation can be claimed
  // and audited safely; the existing same-transaction reuse above stays valid.
  const { data: sameContent, error: sameContentError } = await supabaseAdmin.from('qbo_evidence_items')
    .select('qbo_attachable_id').eq('realm_id', input.realmId)
    .eq('content_sha256', contentHash).eq('qbo_attachment_status', 'verified');
  if (sameContentError) throw new QboAttachmentWorkflowError('Existing company evidence could not be checked for duplicate files', 503);
  const knownIds = new Set((sameContent ?? []).map(row => String(row.qbo_attachable_id ?? '')).filter(Boolean));
  const otherTransactionCopy = normalizeAttachables(firstCheck.attachables).find(attachment =>
    knownIds.has(String(attachment.attachableId ?? '')) &&
    (String(attachment.entityId ?? '') !== qboTxnId || String(attachment.entityType ?? '').toLowerCase() !== qboTxnType.toLowerCase()));
  if (otherTransactionCopy) {
    await appendEvent({ realmId: input.realmId, evidenceItemId: item.id, attemptId: randomUUID(),
      eventType: 'preflight_blocked', qboTxnType, qboTxnId, actorUserId: input.actorUserId,
      qboAttachableId: String(otherTransactionCopy.attachableId), httpStatus: firstCheck.httpStatus,
      details: { reason: 'cross_transaction_duplicate_requires_existing_file_link' } });
    if (isFirstEvidence) await markAdditionalForReview(input.realmId, item.id);
    throw new QboAttachmentWorkflowError('This file already exists on another QuickBooks transaction; do not upload another copy. An approved existing-file link is required.', 409);
  }

  const attemptId = randomUUID();
  const { error: claimError } = await supabaseAdmin.from('qbo_attachment_events').insert({
    realm_id: input.realmId,
    evidence_item_id: item.id,
    attempt_id: attemptId,
    event_type: 'attempt_started',
    qbo_txn_type: qboTxnType,
    qbo_txn_id: qboTxnId,
    actor_user_id: input.actorUserId,
    details: { content_sha256: contentHash },
  });
  if (claimError) {
    if (isUniqueViolation(claimError)) throw new QboAttachmentWorkflowError('An attachment attempt already exists; reconcile it before retrying', 409);
    throw new QboAttachmentWorkflowError('Could not claim the one-time attachment attempt', 503);
  }

  const { data: pendingItem, error: pendingError } = await supabaseAdmin.from('qbo_evidence_items')
    .update({ qbo_attachment_status: 'pending' })
    .eq('realm_id', input.realmId)
    .eq('id', item.id)
    .eq('qbo_attachment_status', 'not_requested')
    .select('id')
    .maybeSingle();
  if (pendingError || !pendingItem) {
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType: 'outcome_unknown', qboTxnType, qboTxnId, actorUserId: input.actorUserId,
      details: { reason: 'evidence_item_claim_update_failed' },
    });
    throw new QboAttachmentWorkflowError('Attachment claim state could not be confirmed; do not retry', 503);
  }

  // Re-check immediately before the write. The database claim prevents this
  // application from racing itself; this read also catches newly added QBO files.
  try {
    const [latestItems, latestTransaction, latestAttachables] = await Promise.all([
      supabaseAdmin.from('qbo_evidence_items').select('id, evidence_role, review_status, qbo_attachment_status').eq('realm_id', input.realmId).eq('register_entry_id', register.id),
      getTransactionById(qboTxnType, qboTxnId, input.realmId),
      getAttachablesForTransaction(qboTxnType, qboTxnId, input.realmId),
    ]);
    if (latestItems.error) throw new Error('evidence-preflight-failed');
    if (!latestTransaction.transaction) throw new Error('transaction-preflight-failed');
    const otherZevidtEvidence = (latestItems.data ?? []).some((related) => blocksFirstEvidence(related, item.id));
    const transactionAlreadyHasQboEvidence = linkedToTransaction(latestAttachables.attachables, qboTxnType, qboTxnId);
    if (isFirstEvidence && (otherZevidtEvidence || transactionAlreadyHasQboEvidence)) {
      await appendEvent({
        realmId: input.realmId, evidenceItemId: item.id, attemptId,
        eventType: 'preflight_blocked', qboTxnType, qboTxnId, actorUserId: input.actorUserId,
        httpStatus: latestAttachables.httpStatus,
        details: { reason: 'evidence_appeared_after_initial_preflight' },
      });
      await markAdditionalForReview(input.realmId, item.id, 'pending');
      const { error: releaseError } = await supabaseAdmin.from('qbo_evidence_items')
        .update({ qbo_attachment_status: 'not_requested' })
        .eq('realm_id', input.realmId)
        .eq('id', item.id)
        .eq('qbo_attachment_status', 'pending');
      if (releaseError) throw new Error('claim-release-failed');
      throw new QboAttachmentWorkflowError('Evidence appeared during preflight; human review is required', 409);
    }
    if (isApprovedAdditional && transactionAlreadyHasQboEvidence) {
      const exact = await findExactTransactionAttachment(latestAttachables.attachables, qboTxnType, qboTxnId, input.realmId, contentHash);
      if (exact) {
        return await linkExactDuplicate({
          realmId: input.realmId, evidenceItemId: item.id, attemptId, actorUserId: input.actorUserId,
          qboTxnType, qboTxnId, contentHash, attachableId: exact.attachableId,
          httpStatus: exact.httpStatus, expectedStatus: 'pending',
        });
      }
    }
  } catch (error) {
    if (error instanceof QboAttachmentWorkflowError) throw error;
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType: 'outcome_unknown', qboTxnType, qboTxnId, actorUserId: input.actorUserId,
      details: { reason: 'final_preflight_unavailable' },
    });
    await supabaseAdmin.from('qbo_evidence_items').update({ qbo_attachment_status: 'unknown' }).eq('realm_id', input.realmId).eq('id', item.id);
    throw new QboAttachmentWorkflowError('Final preflight failed; the item is locked for reconciliation', 503);
  }

  let uploaded: Awaited<ReturnType<typeof uploadAttachable>>;
  try {
    uploaded = await uploadAttachable(fileBytes, document.filename, validation.contentType, qboTxnType, qboTxnId, input.realmId);
  } catch (error) {
    const httpStatus = Number((error as { status?: number })?.status) || null;
    const definiteClientFailure = httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
    const eventType = definiteClientFailure ? 'upload_failed' : 'outcome_unknown';
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType, qboTxnType, qboTxnId, httpStatus, actorUserId: input.actorUserId,
      details: { reason: definiteClientFailure ? 'qbo_rejected_upload' : 'upload_response_ambiguous' },
    });
    await supabaseAdmin.from('qbo_evidence_items').update({ qbo_attachment_status: definiteClientFailure ? 'failed' : 'unknown' }).eq('realm_id', input.realmId).eq('id', item.id);
    throw new QboAttachmentWorkflowError(definiteClientFailure ? 'QuickBooks rejected the attachment upload' : 'Upload outcome is unknown; reconcile before retrying', 502);
  }

  const attachableId = String(uploaded.attachable?.Id ?? uploaded.attachable?.id ?? '');
  if (!attachableId) {
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType: 'outcome_unknown', qboTxnType, qboTxnId,
      httpStatus: uploaded.httpStatus, actorUserId: input.actorUserId,
      details: { reason: 'qbo_response_missing_attachable_id' },
    });
    await supabaseAdmin.from('qbo_evidence_items').update({ qbo_attachment_status: 'unknown' }).eq('realm_id', input.realmId).eq('id', item.id);
    throw new QboAttachmentWorkflowError('QuickBooks accepted a response without a usable attachment ID; reconcile before retrying', 502);
  }

  await appendEvent({
    realmId: input.realmId, evidenceItemId: item.id, attemptId,
    eventType: 'upload_succeeded', qboTxnType, qboTxnId,
    qboAttachableId: attachableId, httpStatus: uploaded.httpStatus,
    actorUserId: input.actorUserId, details: { response_received: true },
  });
  const { error: uploadedStateError } = await supabaseAdmin.from('qbo_evidence_items')
    .update({ qbo_attachment_status: 'uploaded', qbo_attachable_id: attachableId })
    .eq('realm_id', input.realmId).eq('id', item.id).eq('qbo_attachment_status', 'pending');
  if (uploadedStateError) throw new QboAttachmentWorkflowError('Upload is recorded; item status needs reconciliation before retry', 503);

  let readback: Awaited<ReturnType<typeof getAttachableById>>;
  try {
    readback = await getAttachableById(attachableId, input.realmId);
  } catch {
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType: 'verification_failed', qboTxnType, qboTxnId,
      qboAttachableId: attachableId, actorUserId: input.actorUserId,
      details: { reason: 'readback_request_failed' },
    });
    await supabaseAdmin.from('qbo_evidence_items').update({ qbo_attachment_status: 'unknown' }).eq('realm_id', input.realmId).eq('id', item.id);
    throw new QboAttachmentWorkflowError('Upload is recorded but read-back verification failed; do not retry', 502);
  }
  const verified = normalizeAttachables(readback.attachables).some((attachable) =>
    String(attachable.attachableId ?? '') === attachableId &&
    String(attachable.entityId ?? '') === qboTxnId &&
    String(attachable.entityType ?? '').toLowerCase() === qboTxnType.toLowerCase()
  );
  if (!verified) {
    await appendEvent({
      realmId: input.realmId, evidenceItemId: item.id, attemptId,
      eventType: 'verification_failed', qboTxnType, qboTxnId,
      qboAttachableId: attachableId, httpStatus: readback.httpStatus,
      actorUserId: input.actorUserId,
      details: { reason: 'attachment_not_linked_to_expected_transaction' },
    });
    await supabaseAdmin.from('qbo_evidence_items').update({ qbo_attachment_status: 'unknown' }).eq('realm_id', input.realmId).eq('id', item.id);
    throw new QboAttachmentWorkflowError('Attachment exists but its transaction association was not verified', 502);
  }

  await appendEvent({
    realmId: input.realmId, evidenceItemId: item.id, attemptId,
    eventType: 'verification_succeeded', qboTxnType, qboTxnId,
    qboAttachableId: attachableId, httpStatus: readback.httpStatus,
    actorUserId: input.actorUserId,
    details: { association_verified: true },
  });
  const { error: verifiedStateError } = await supabaseAdmin.from('qbo_evidence_items')
    .update({ qbo_attachment_status: 'verified', qbo_attachable_id: attachableId })
    .eq('realm_id', input.realmId).eq('id', item.id).eq('qbo_attachment_status', 'uploaded');
  if (verifiedStateError) throw new QboAttachmentWorkflowError('Read-back was verified; item status needs reconciliation', 503);

  return { evidenceItemId: item.id, qboTxnId, qboAttachableId: attachableId, status: 'verified' as const };
}
