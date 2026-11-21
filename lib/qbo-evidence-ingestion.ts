import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getAttachables, normalizeAttachables } from '@/lib/quickbooks';
import { uploadFirstEvidenceItemToQbo } from '@/lib/qbo-attachment-workflow';
import type { ProcessedDocumentResult } from '@/lib/document-extraction';
import { qboTransactionEntityType } from '@/lib/qbo-transaction-types';

type EvidenceRegisterReference = {
  id: string;
  realm_id: string;
  qbo_txn_id: string;
  qbo_txn_type: string | null;
  register_state: string;
  matched_document_id: string | null;
};

export interface EvidenceIngestionResult {
  evidenceItemId: string | null;
  evidenceRole: 'primary' | 'additional' | 'unassigned' | null;
  qboAttachmentStatus: string | null;
  error?: string;
}

/** Persist the classified evidence item and attach only the unambiguous first item. */
export async function recordProcessedEvidence(input: {
  realmId: string;
  documentId: string;
  result: ProcessedDocumentResult;
  actorUserId?: string | null;
}): Promise<EvidenceIngestionResult> {
  const { data: existing, error: existingError } = await supabaseAdmin.from('qbo_evidence_items')
    .select('id, evidence_role, qbo_attachment_status')
    .eq('realm_id', input.realmId)
    .eq('inbox_document_id', input.documentId)
    .maybeSingle();
  if (existingError) throw new Error('Evidence item table is unavailable or could not be read');
  if (existing) {
    return { evidenceItemId: existing.id, evidenceRole: existing.evidence_role, qboAttachmentStatus: existing.qbo_attachment_status };
  }

  const { data: document, error: documentError } = await supabaseAdmin.from('inbox_documents')
    .select('id, realm_id, storage_path, filename, content_type, file_size')
    .eq('realm_id', input.realmId)
    .eq('id', input.documentId)
    .maybeSingle();
  if (documentError || !document) throw new Error('Uploaded evidence metadata could not be verified');
  const { data: storedFile, error: storageError } = await supabaseAdmin.storage.from('evidence').download(document.storage_path);
  if (storageError || !storedFile) throw new Error('Stored evidence could not be verified');
  const bytes = Buffer.from(await storedFile.arrayBuffer());
  if (bytes.length !== Number(document.file_size)) throw new Error('Stored evidence size does not match its metadata');
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');

  const match = input.result.matchResult;
  const transactionId = match.status === 'matched' ? match.transactionId : null;
  let register: EvidenceRegisterReference | null = null;
  if (transactionId) {
    const { data, error } = await supabaseAdmin.from('qbo_evidence_register')
      .select('id, realm_id, qbo_txn_id, qbo_txn_type, register_state, matched_document_id')
      .eq('realm_id', input.realmId)
      .eq('qbo_txn_id', transactionId)
      .maybeSingle();
    if (error) throw new Error('Matched transaction register entry could not be verified');
    register = data;
  } else {
    const { data, error } = await supabaseAdmin.from('qbo_evidence_register')
      .select('id, realm_id, qbo_txn_id, qbo_txn_type, register_state, matched_document_id')
      .eq('realm_id', input.realmId)
      .eq('matched_document_id', input.documentId)
      .maybeSingle();
    if (error) throw new Error('Evidence register entry could not be verified');
    register = data;
  }

  let matchStatus: 'verified' | 'potential' | 'wrong_match' | 'duplicate' | 'unreviewed' = 'unreviewed';
  let reviewStatus: 'not_required' | 'required' = 'required';
  let evidenceRole: 'primary' | 'additional' | 'unassigned' = 'unassigned';
  let registerEntryId: string | null = null;
  const proposedRegisterEntryId: string | null = null;
  let candidateIds: string[] = [];
  let duplicateOfItemId: string | null = null;

  if (input.result.isDuplicate) {
    matchStatus = 'duplicate';
    const duplicateDocumentId = input.result.duplicateOfDocumentId;
    if (duplicateDocumentId) {
      const { data: duplicateItem } = await supabaseAdmin.from('qbo_evidence_items')
        .select('id').eq('realm_id', input.realmId).eq('inbox_document_id', duplicateDocumentId).maybeSingle();
      duplicateOfItemId = duplicateItem?.id ?? null;
    }
  } else if (match.status === 'multiple_candidates') {
    matchStatus = 'potential';
    candidateIds = [...new Set((match.allCandidates ?? []).map((candidate) => candidate.txnId).filter(Boolean))];
  } else if (register?.register_state === 'WRONG_MATCHED') {
    matchStatus = 'wrong_match';
    registerEntryId = register.id;
    candidateIds = match.transactionId ? [match.transactionId] : [];
  } else if (
    match.status === 'matched' &&
    register?.register_state === 'MATCHED' &&
    register.qbo_txn_id === match.transactionId
  ) {
    matchStatus = 'verified';
    registerEntryId = register.id;
    candidateIds = match.transactionId ? [match.transactionId] : [];

    if (register.matched_document_id && register.matched_document_id !== input.documentId) {
      // The transaction already has a different verified document in its register row.
      // Preserve it and require a separate human approval for this additional file.
      evidenceRole = 'additional';
      reviewStatus = 'required';
    } else {
      const { data: existingTransactionItems, error: itemCheckError } = await supabaseAdmin.from('qbo_evidence_items')
        .select('id')
        .eq('realm_id', input.realmId)
        .eq('register_entry_id', register.id);
      if (itemCheckError) throw new Error('Existing Zevidt evidence could not be checked');

      let qboHasEvidence = true;
      try {
        const attachables = await getAttachables(input.realmId);
        const entityType = qboTransactionEntityType(String(register.qbo_txn_type ?? ''));
        qboHasEvidence = !entityType || normalizeAttachables(attachables.attachables).some((attachable) =>
          String(attachable.entityId ?? '') === String(register!.qbo_txn_id) &&
          String(attachable.entityType ?? '').toLowerCase() === entityType.toLowerCase()
        );
      } catch {
        // An unavailable QBO read can never authorize an automatic attachment.
        qboHasEvidence = true;
      }

      if ((existingTransactionItems ?? []).length === 0 && !qboHasEvidence) {
      evidenceRole = 'primary';
      reviewStatus = 'not_required';
      } else {
        evidenceRole = 'additional';
        reviewStatus = 'required';
      }
    }
  }

  const payload = {
    realm_id: input.realmId,
    register_entry_id: registerEntryId,
    proposed_register_entry_id: proposedRegisterEntryId,
    candidate_qbo_txn_ids: candidateIds,
    source_type: 'client_upload',
    inbox_document_id: input.documentId,
    content_sha256: contentSha256,
    match_confidence: match.confidence,
    match_evidence: match.candidateDetails ?? null,
    match_status: matchStatus,
    review_status: reviewStatus,
    evidence_role: evidenceRole,
    qbo_attachment_status: 'not_requested',
    duplicate_of_item_id: duplicateOfItemId,
  };
  let { data: inserted, error: insertError } = await supabaseAdmin.from('qbo_evidence_items')
    .insert(payload).select('id, evidence_role, qbo_attachment_status').single();

  if (insertError?.code === '23505' && evidenceRole === 'primary') {
    // Another document won the primary slot concurrently. Keep this document;
    // downgrade it to additional evidence requiring human review.
    ({ data: inserted, error: insertError } = await supabaseAdmin.from('qbo_evidence_items')
      .insert({ ...payload, evidence_role: 'additional', review_status: 'required' })
      .select('id, evidence_role, qbo_attachment_status').single());
  }
  if (insertError || !inserted) {
    if (insertError?.code === '23505') {
      const { data: racedItem } = await supabaseAdmin.from('qbo_evidence_items')
        .select('id, evidence_role, qbo_attachment_status')
        .eq('realm_id', input.realmId).eq('inbox_document_id', input.documentId).maybeSingle();
      if (racedItem) return { evidenceItemId: racedItem.id, evidenceRole: racedItem.evidence_role, qboAttachmentStatus: racedItem.qbo_attachment_status };
    }
    throw new Error('Evidence item could not be safely recorded');
  }

  if (inserted.evidence_role !== 'primary') {
    return { evidenceItemId: inserted.id, evidenceRole: inserted.evidence_role, qboAttachmentStatus: inserted.qbo_attachment_status };
  }

  try {
    const uploadResult = await uploadFirstEvidenceItemToQbo({
      evidenceItemId: inserted.id,
      realmId: input.realmId,
      actorUserId: input.actorUserId ?? null,
    });
    return { evidenceItemId: inserted.id, evidenceRole: 'primary', qboAttachmentStatus: uploadResult.status };
  } catch (error) {
    const { data: latestItem } = await supabaseAdmin.from('qbo_evidence_items')
      .select('qbo_attachment_status, evidence_role')
      .eq('realm_id', input.realmId)
      .eq('id', inserted.id)
      .maybeSingle();
    return {
      evidenceItemId: inserted.id,
      evidenceRole: latestItem?.evidence_role ?? inserted.evidence_role,
      qboAttachmentStatus: latestItem?.qbo_attachment_status ?? 'unknown',
      error: error instanceof Error ? error.message : 'Attachment outcome requires review',
    };
  }
}
