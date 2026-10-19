/**
 * QBO Evidence Register State Engine
 *
 * Classifies every QBO transaction and its attachment(s) into 4 states:
 * - MATCHED: Correct attachment for this transaction (deterministic match)
 * - WRONG_MATCHED: Proven incorrect pre-existing QBO attachment (matches a different transaction)
 * - MISSING: No supporting document exists for a transaction
 * - REVIEW_REQUIRED: Possible transaction match exists but cannot be deterministically resolved
 *
 * Rules:
 * - A document currently attached to a transaction must still be analysed against
 *   other QBO transactions before being classified as MATCHED.
 * - Automatic matching produces only MATCHED (deterministic), REVIEW_REQUIRED (ambiguous),
 *   or leaves transaction as MISSING.
 * - WRONG_MATCHED only represents a proven incorrect pre-existing QBO attachment.
 *   The automatic matcher must never create WRONG_MATCHED.
 * - Preserve the original QBO attachment relationship and all existing evidence.
 * - Reuse the current extraction, scoring and confidence thresholds.
 */

import { supabaseAdmin } from './supabase-admin';
import {
  matchDocumentToTransactions,
  ExtractedDocumentFields,
  QBOTransaction,
  MatchResult,
  CandidateMatchDetail,
  getCollectionRequestWithTransactions,
  extractFieldsFromText,
  downloadDocument,
  getClaimedTransactionIds,
} from './document-extraction';
import { getAttachables, normalizeAttachables, getTransactions, normalizeTransactionList } from './quickbooks';

// Local copy of extractTextFromDocument since it's not exported
async function extractTextFromDocument(buffer: Buffer, contentType: string): Promise<string> {
  if (contentType === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text;
  }

  if (contentType.startsWith('image/')) {
    return '[IMAGE CONTENT - OCR NOT IMPLEMENTED]';
  }

  if (contentType === 'text/plain') {
    return buffer.toString('utf-8');
  }

  try {
    return buffer.toString('utf-8');
  } catch {
    return '[UNSUPPORTED DOCUMENT TYPE]';
  }
}

export type QboRegisterState =
  | 'MATCHED'
  | 'WRONG_MATCHED'
  | 'MISSING'
  | 'REVIEW_REQUIRED';

export interface RegisterEntry {
  id?: string; // Database ID after persistence
  realmId: string;
  collectionRequestId: string | null;

  // QBO Transaction
  qboTxnId: string | null;
  qboTxnType: string | null;
  qboTxnDate: string | null;
  qboTxnVendor: string | null;
  qboTxnAmount: number | null;
  qboTxnDocNumber: string | null;

  // Attachment (if any)
  attachableId: string | null;
  attachmentFilename: string | null;
  attachmentFileSize: number | null;
  attachmentDownloadUrl: string | null;

  // Register state
  registerState: QboRegisterState;

  // Matching details
  matchedDocumentId: string | null;
  matchConfidence: number | null;
  matchFieldDetails: CandidateMatchDetail[] | null;

  // For WRONG_MATCHED
  correctQboTxnId: string | null;

  // For REVIEW_REQUIRED
  reviewCandidateTxnIds: string[];
}

export interface BuildRegisterOptions {
  realmId: string;
  collectionRequestId?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Build the complete QBO evidence register for a realm.
 * This is the main entry point that computes all 4 register states.
 */
export async function buildQboEvidenceRegister(
  options: BuildRegisterOptions
): Promise<RegisterEntry[]> {
  const { realmId, collectionRequestId, startDate, endDate } = options;

  // 1. Fetch all QBO transactions (from collection request or date range)
  const allTransactions = await fetchQboTransactions(realmId, collectionRequestId, startDate, endDate);

  // 2. Fetch all QBO attachments (Attachables) for this realm
  const attachables = await fetchQboAttachables(realmId);

  // 3. Fetch all inbox documents for this realm
  const inboxDocuments = await fetchInboxDocuments(realmId);

  // 4. Extract fields from all inbox documents (if not already done)
  const documentFields = await extractFieldsFromAllDocuments(inboxDocuments);

  // 5. Pre-filter claimed transactions ONCE to avoid duplicate getClaimedTransactionIds calls
  const claimedIds = await getClaimedTransactionIds(realmId);
  const transactions = allTransactions.filter(txn => !claimedIds.has(txn.txnId));

  // 6. Match each document against ALL transactions (not just the one it's attached to)
  const allMatchResults = await matchAllDocumentsToAllTransactions(
    inboxDocuments,
    documentFields,
    transactions,
    collectionRequestId,
    realmId
  );

  // 7. Analyze QBO-side: for each transaction, check its existing attachment(s)
  //    and classify into register states
  const qboSideEntries = await analyzeQboSide(
    transactions,
    attachables,
    inboxDocuments,
    documentFields,
    allMatchResults,
    collectionRequestId,
    realmId
  );

  // 8. Analyze document-side: find documents that don't match any transaction
  const documentSideEntries = analyzeDocumentSide(
    inboxDocuments,
    documentFields,
    allMatchResults,
    transactions,
    qboSideEntries,
    collectionRequestId
  );

  // 9. Resolve conflicts (ensure consistent states)
  const finalEntries = resolveStateConflicts([...qboSideEntries, ...documentSideEntries]);

  // 10. Set realmId on all entries
  for (const entry of finalEntries) {
    entry.realmId = realmId;
  }

  return finalEntries;
}

/**
 * Fetch QBO transactions from collection request or date range
 */
async function fetchQboTransactions(
  realmId: string,
  collectionRequestId: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<QBOTransaction[]> {
  if (collectionRequestId) {
    const request = await getCollectionRequestWithTransactions(collectionRequestId);
    if (request) return request.transactions;
  }

  // Fallback: fetch from QBO API using date range
  if (startDate && endDate) {
    const raw = await getTransactions(startDate, endDate);
    return normalizeTransactionList(raw);
  }

  return [];
}

/**
 * Fetch all QBO attachables for a realm
 */
async function fetchQboAttachables(realmId: string) {
  const raw = await getAttachables();
  return normalizeAttachables(raw);
}

/**
 * Fetch all inbox documents for a realm
 */
async function fetchInboxDocuments(realmId: string) {
  const { data, error } = await supabaseAdmin
    .from('inbox_documents')
    .select('*')
    .eq('realm_id', realmId);

  if (error) throw new Error(`Failed to fetch inbox documents: ${error.message}`);
  return data || [];
}

/**
 * Extract fields from all documents
 */
async function extractFieldsFromAllDocuments(documents: any[]): Promise<Map<string, ExtractedDocumentFields>> {
  const fieldsMap = new Map<string, ExtractedDocumentFields>();

  for (const doc of documents) {
    if (doc.extracted_vendor && doc.extracted_amount !== null) {
      // Already extracted, use stored values
      fieldsMap.set(doc.id, {
        vendorName: doc.extracted_vendor,
        documentDate: doc.extracted_date,
        totalAmount: doc.extracted_amount,
        documentNumber: doc.extracted_document_number,
        documentType: doc.extracted_type,
        rawText: '', // Not stored
      });
    } else {
      // Need to extract
      try {
        const buffer = await downloadDocument(doc.storage_path);
        const text = await extractTextFromDocument(buffer, doc.content_type);
        const fields = extractFieldsFromText(text);
        fieldsMap.set(doc.id, fields);
      } catch (e) {
        console.error(`Failed to extract fields from document ${doc.id}:`, e);
        fieldsMap.set(doc.id, {
          vendorName: null,
          documentDate: null,
          totalAmount: null,
          documentNumber: null,
          documentType: null,
          rawText: '',
        });
      }
    }
  }

  return fieldsMap;
}

/**
 * Match each document against ALL transactions using pre-extracted fields and pre-fetched transactions.
 * This avoids duplicate downloading/extraction/matching work.
 */
async function matchAllDocumentsToAllTransactions(
  documents: any[],
  documentFields: Map<string, ExtractedDocumentFields>,
  transactions: QBOTransaction[],
  collectionRequestId: string | undefined,
  realmId: string
): Promise<Map<string, MatchResult>> {
  const results = new Map<string, MatchResult>();

  for (const doc of documents) {
    const fields = documentFields.get(doc.id);
    if (!fields) continue;

    // Use pre-extracted fields and pre-fetched transactions to avoid duplicate work
    const matchResult = await matchDocumentToTransactions(
      doc.id,
      fields,
      collectionRequestId,
      transactions,  // Pass pre-fetched transactions
      realmId        // Pass realmId for claimed transaction filtering
    );
    results.set(doc.id, matchResult);
  }

  return results;
}

/**
 * Analyze QBO side: for each transaction + its attachment(s), classify the register state
 */
export async function analyzeQboSide(
  transactions: QBOTransaction[],
  attachables: any[],
  inboxDocuments: any[],
  documentFields: Map<string, ExtractedDocumentFields>,
  allMatchResults: Map<string, MatchResult>,
  collectionRequestId: string | undefined,
  realmId: string
): Promise<RegisterEntry[]> {
  const entries: RegisterEntry[] = [];

  // Group attachables by entityId (transaction they're attached to)
  const attachablesByTxn = new Map<string, any[]>();
  for (const att of attachables) {
    if (att.entityId) {
      const existing = attachablesByTxn.get(att.entityId) || [];
      existing.push(att);
      attachablesByTxn.set(att.entityId, existing);
    }
  }

  // Also track orphaned attachables (no entityId)
  const orphanedAttachables = attachables.filter(a => !a.entityId);

  for (const txn of transactions) {
    const txnAttachables = attachablesByTxn.get(txn.txnId) || [];

    if (txnAttachables.length === 0) {
      // Transaction has no attachment -> MISSING
      entries.push(createRegisterEntry({
        realmId: '', // Will be filled by caller
        collectionRequestId: collectionRequestId ?? null,
        qboTxnId: txn.txnId,
        qboTxnType: txn.txnType ?? null,
        qboTxnDate: txn.date ?? null,
        qboTxnVendor: txn.vendor ?? null,
        qboTxnAmount: txn.amount ?? null,
        qboTxnDocNumber: txn.docNumber ?? null,
        attachableId: null,
        attachmentFilename: null,
        attachmentFileSize: null,
        attachmentDownloadUrl: null,
        registerState: 'MISSING',
        matchedDocumentId: null,
        matchConfidence: null,
        matchFieldDetails: null,
        correctQboTxnId: null,
        reviewCandidateTxnIds: [],
      }));
      continue;
    }

    // Transaction has attachment(s) - analyze each one
    for (const att of txnAttachables) {
      // Find which inbox document corresponds to this attachable
      const matchingDoc = findInboxDocumentForAttachable(att, inboxDocuments);

      if (matchingDoc) {
        // This attachable corresponds to an inbox document
        const matchResult = allMatchResults.get(matchingDoc.id);

        if (matchResult && matchResult.status === 'matched' && matchResult.transactionId === txn.txnId) {
          // Document is matched to THIS transaction -> MATCHED
          entries.push(createRegisterEntry({
            realmId: '',
            collectionRequestId: collectionRequestId ?? null,
            qboTxnId: txn.txnId,
            qboTxnType: txn.txnType ?? null,
            qboTxnDate: txn.date ?? null,
            qboTxnVendor: txn.vendor ?? null,
            qboTxnAmount: txn.amount ?? null,
            qboTxnDocNumber: txn.docNumber ?? null,
            attachableId: att.attachableId ?? null,
            attachmentFilename: att.fileName ?? null,
            attachmentFileSize: att.fileSize ?? null,
            attachmentDownloadUrl: att.downloadUrl ?? null,
            registerState: 'MATCHED',
            matchedDocumentId: matchingDoc.id,
            matchConfidence: matchResult.confidence,
            matchFieldDetails: matchResult.candidateDetails ?? null,
            correctQboTxnId: null,
            reviewCandidateTxnIds: [],
          }));
        } else if (matchResult && matchResult.status === 'matched' && matchResult.transactionId !== txn.txnId) {
          // Document is matched to a DIFFERENT transaction -> WRONG_MATCHED
          // This represents a proven incorrect pre-existing QBO attachment
          entries.push(createRegisterEntry({
            realmId: '',
            collectionRequestId: collectionRequestId ?? null,
            qboTxnId: txn.txnId,
            qboTxnType: txn.txnType ?? null,
            qboTxnDate: txn.date ?? null,
            qboTxnVendor: txn.vendor ?? null,
            qboTxnAmount: txn.amount ?? null,
            qboTxnDocNumber: txn.docNumber ?? null,
            attachableId: att.attachableId ?? null,
            attachmentFilename: att.fileName ?? null,
            attachmentFileSize: att.fileSize ?? null,
            attachmentDownloadUrl: att.downloadUrl ?? null,
            registerState: 'WRONG_MATCHED',
            matchedDocumentId: matchingDoc.id,
            matchConfidence: matchResult.confidence,
            matchFieldDetails: matchResult.candidateDetails ?? null,
            correctQboTxnId: matchResult.transactionId ?? null,
            reviewCandidateTxnIds: [],
          }));
        } else if (matchResult && matchResult.status === 'multiple_candidates') {
          // Ambiguous match -> REVIEW_REQUIRED
          const candidateTxnIds = matchResult.allCandidates?.map(c => c.txnId) ?? [];
          entries.push(createRegisterEntry({
            realmId: '',
            collectionRequestId: collectionRequestId ?? null,
            qboTxnId: txn.txnId,
            qboTxnType: txn.txnType ?? null,
            qboTxnDate: txn.date ?? null,
            qboTxnVendor: txn.vendor ?? null,
            qboTxnAmount: txn.amount ?? null,
            qboTxnDocNumber: txn.docNumber ?? null,
            attachableId: att.attachableId ?? null,
            attachmentFilename: att.fileName ?? null,
            attachmentFileSize: att.fileSize ?? null,
            attachmentDownloadUrl: att.downloadUrl ?? null,
            registerState: 'REVIEW_REQUIRED',
            matchedDocumentId: matchingDoc.id,
            matchConfidence: matchResult.confidence,
            matchFieldDetails: matchResult.candidateDetails ?? null,
            correctQboTxnId: null,
            reviewCandidateTxnIds: candidateTxnIds,
          }));
        } else {
          // Attachment exists in QBO on this transaction but matcher cannot establish
          // a definitive document match. Evidence exists; needs human review.
          entries.push(createRegisterEntry({
            realmId: '',
            collectionRequestId: collectionRequestId ?? null,
            qboTxnId: txn.txnId,
            qboTxnType: txn.txnType ?? null,
            qboTxnDate: txn.date ?? null,
            qboTxnVendor: txn.vendor ?? null,
            qboTxnAmount: txn.amount ?? null,
            qboTxnDocNumber: txn.docNumber ?? null,
            attachableId: att.attachableId ?? null,
            attachmentFilename: att.fileName ?? null,
            attachmentFileSize: att.fileSize ?? null,
            attachmentDownloadUrl: att.downloadUrl ?? null,
            registerState: 'REVIEW_REQUIRED',
            matchedDocumentId: matchingDoc.id,
            matchConfidence: matchResult?.confidence ?? null,
            matchFieldDetails: matchResult?.candidateDetails ?? null,
            correctQboTxnId: null,
            reviewCandidateTxnIds: [],
          }));
        }
      } else {
        // Attachment exists in QBO and is linked to this transaction,
        // but no corresponding inbox document was found.
        // The attachment must remain visible for human review.
        // The absence of an inbox document does not mean the QBO attachment is missing.
        entries.push(createRegisterEntry({
          realmId: '',
          collectionRequestId: collectionRequestId ?? null,
          qboTxnId: txn.txnId,
          qboTxnType: txn.txnType ?? null,
          qboTxnDate: txn.date ?? null,
          qboTxnVendor: txn.vendor ?? null,
          qboTxnAmount: txn.amount ?? null,
          qboTxnDocNumber: txn.docNumber ?? null,
          attachableId: att.attachableId ?? null,
          attachmentFilename: att.fileName ?? null,
          attachmentFileSize: att.fileSize ?? null,
          attachmentDownloadUrl: att.downloadUrl ?? null,
          registerState: 'REVIEW_REQUIRED',
          matchedDocumentId: null,
          matchConfidence: null,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: [],
        }));
      }
    }
  }

  // Handle orphaned attachables (attachments in QBO not linked to any transaction)
  for (const att of orphanedAttachables) {
    const matchingDoc = findInboxDocumentForAttachable(att, inboxDocuments);

    entries.push(createRegisterEntry({
      realmId: '',
      collectionRequestId: collectionRequestId ?? null,
      qboTxnId: null,
      qboTxnType: null,
      qboTxnDate: null,
      qboTxnVendor: null,
      qboTxnAmount: null,
      qboTxnDocNumber: null,
      attachableId: att.attachableId ?? null,
      attachmentFilename: att.fileName ?? null,
      attachmentFileSize: att.fileSize ?? null,
      attachmentDownloadUrl: att.downloadUrl ?? null,
      registerState: 'REVIEW_REQUIRED',
      matchedDocumentId: matchingDoc?.id ?? null,
      matchConfidence: null,
      matchFieldDetails: null,
      correctQboTxnId: null,
      reviewCandidateTxnIds: [],
    }));
  }

  return entries;
}

/**
 * Analyze document side: find documents that don't match any transaction
 * Restored from historical implementation (commit 0d50c24) adapted to 4-state model
 */
function analyzeDocumentSide(
  inboxDocuments: any[],
  documentFields: Map<string, ExtractedDocumentFields>,
  allMatchResults: Map<string, MatchResult>,
  transactions: QBOTransaction[],
  qboSideEntries: RegisterEntry[],
  collectionRequestId: string | undefined
): RegisterEntry[] {
  const entries: RegisterEntry[] = [];

  // Track which documents are already accounted for in QBO-side entries
  const accountedDocumentIds = new Set(
    qboSideEntries
      .filter(e => e.matchedDocumentId)
      .map(e => e.matchedDocumentId!)
      .filter(Boolean)
  );

  // Build a map of transaction -> QBO-side register state for conflict detection
  const txnToQboState = new Map<string, { state: QboRegisterState; entry: RegisterEntry }>();
  for (const entry of qboSideEntries) {
    if (entry.qboTxnId && entry.matchedDocumentId) {
      txnToQboState.set(entry.qboTxnId, { state: entry.registerState, entry });
    }
  }

  for (const doc of inboxDocuments) {
    if (accountedDocumentIds.has(doc.id)) continue;

    const matchResult = allMatchResults.get(doc.id);

    if (matchResult && matchResult.status === 'matched') {
      // Document matched to a transaction deterministically
      // Check if that transaction already has a MATCHED entry from QBO-side
      // (which would make this WRONG_MATCHED - but only for pre-existing QBO attachments)
      // For document-side, we create MATCHED if no QBO-side conflict
      const qboState = txnToQboState.get(matchResult.transactionId!);
      
      if (qboState && qboState.state === 'MATCHED' && qboState.entry.matchedDocumentId !== doc.id) {
        // This transaction is already MATCHED with a different document in QBO
        // This document is WRONG_MATCHED (proven incorrect pre-existing attachment)
        // But per rules, automatic matcher never creates WRONG_MATCHED for new documents
        // This case should only happen for pre-existing QBO attachments, so we skip
        // creating a document-side entry to avoid duplication
        continue;
      }

      // Document-side MATCHED: document matches transaction but isn't attached in QBO
      entries.push(createRegisterEntry({
        realmId: '',
        collectionRequestId: collectionRequestId ?? null,
        qboTxnId: matchResult.transactionId ?? null,
        qboTxnType: matchResult.matchedTransaction?.txnType ?? null,
        qboTxnDate: matchResult.matchedTransaction?.date ?? null,
        qboTxnVendor: matchResult.matchedTransaction?.vendor ?? null,
        qboTxnAmount: matchResult.matchedTransaction?.amount ?? null,
        qboTxnDocNumber: matchResult.matchedTransaction?.docNumber ?? null,
        attachableId: null,
        attachmentFilename: doc.filename ?? null,
        attachmentFileSize: doc.file_size ?? null,
        attachmentDownloadUrl: null,
        registerState: 'MATCHED',
        matchedDocumentId: doc.id,
        matchConfidence: matchResult.confidence,
        matchFieldDetails: matchResult.candidateDetails ?? null,
        correctQboTxnId: null,
        reviewCandidateTxnIds: [],
      }));
    } else if (matchResult && matchResult.status === 'multiple_candidates') {
      // Ambiguous match -> REVIEW_REQUIRED
      const candidateTxnIds = matchResult.allCandidates?.map(c => c.txnId) ?? [];
      entries.push(createRegisterEntry({
        realmId: '',
        collectionRequestId: collectionRequestId ?? null,
        qboTxnId: matchResult.allCandidates?.[0]?.txnId ?? null,
        qboTxnType: matchResult.allCandidates?.[0]?.txnType ?? null,
        qboTxnDate: matchResult.allCandidates?.[0]?.date ?? null,
        qboTxnVendor: matchResult.allCandidates?.[0]?.vendor ?? null,
        qboTxnAmount: matchResult.allCandidates?.[0]?.amount ?? null,
        qboTxnDocNumber: matchResult.allCandidates?.[0]?.docNumber ?? null,
        attachableId: null,
        attachmentFilename: doc.filename ?? null,
        attachmentFileSize: doc.file_size ?? null,
        attachmentDownloadUrl: null,
        registerState: 'REVIEW_REQUIRED',
        matchedDocumentId: doc.id,
        matchConfidence: matchResult.confidence,
        matchFieldDetails: matchResult.candidateDetails ?? null,
        correctQboTxnId: null,
        reviewCandidateTxnIds: candidateTxnIds,
      }));
    } else {
      // No match found at all -> document exists but cannot be matched to any transaction
      // In 4-state model, we create a MISSING entry for the document to track it
      // This preserves document ID and allows review, but doesn't invent transaction IDs
      entries.push(createRegisterEntry({
        realmId: '',
        collectionRequestId: collectionRequestId ?? null,
        qboTxnId: null,
        qboTxnType: null,
        qboTxnDate: null,
        qboTxnVendor: null,
        qboTxnAmount: null,
        qboTxnDocNumber: null,
        attachableId: null,
        attachmentFilename: doc.filename ?? null,
        attachmentFileSize: doc.file_size ?? null,
        attachmentDownloadUrl: null,
        registerState: 'MISSING',
        matchedDocumentId: doc.id,
        matchConfidence: matchResult?.confidence ?? null,
        matchFieldDetails: matchResult?.candidateDetails ?? null,
        correctQboTxnId: null,
        reviewCandidateTxnIds: [],
      }));
    }
  }

  return entries;
}

/**
 * Resolve state conflicts to ensure consistency - restored from historical implementation
 * adapted to 4-state model
 */
function resolveStateConflicts(entries: RegisterEntry[]): RegisterEntry[] {
  // Track document -> assigned state
  const documentStates = new Map<string, { state: QboRegisterState; entry: RegisterEntry }>();
  
  // Track transaction -> assigned state (for MATCHED/WRONG_MATCHED conflicts)
  const transactionStates = new Map<string, { state: QboRegisterState; entry: RegisterEntry }>();

  // First pass: identify conflicts
  for (const entry of entries) {
    const docId = entry.matchedDocumentId;
    
    // Handle document-level conflicts
    if (docId) {
      const existing = documentStates.get(docId);
      if (!existing) {
        documentStates.set(docId, { state: entry.registerState, entry });
      } else {
        // Conflict resolution rules for 4-state model:
        // Priority: MATCHED > WRONG_MATCHED > REVIEW_REQUIRED > MISSING
        // WRONG_MATCHED is preserved as it represents proven incorrect pre-existing attachment
        // MATCHED (deterministic) takes precedence over REVIEW_REQUIRED
        // REVIEW_REQUIRED preserves ambiguous results
        // MISSING is lowest priority
        const priority = getStatePriority(entry.registerState);
        const existingPriority = getStatePriority(existing.state);

        if (priority > existingPriority) {
          // Current entry has higher priority, demote existing to MISSING
          // (We don't use DUPLICATE in 4-state model)
          existing.entry.registerState = 'MISSING';
          existing.entry.matchedDocumentId = null;
          existing.entry.matchConfidence = null;
          existing.entry.matchFieldDetails = null;
          existing.entry.reviewCandidateTxnIds = [];
          documentStates.set(docId, { state: entry.registerState, entry });
        } else {
          // Existing has higher or equal priority, demote current to MISSING
          entry.registerState = 'MISSING';
          entry.matchedDocumentId = null;
          entry.matchConfidence = null;
          entry.matchFieldDetails = null;
          entry.reviewCandidateTxnIds = [];
        }
      }
    }

    // Handle transaction-level conflicts (for MATCHED/WRONG_MATCHED)
    if (entry.qboTxnId && (entry.registerState === 'MATCHED' || entry.registerState === 'WRONG_MATCHED')) {
      const existing = transactionStates.get(entry.qboTxnId);
      if (!existing) {
        transactionStates.set(entry.qboTxnId, { state: entry.registerState, entry });
      } else {
        // Transaction can only have one MATCHED or WRONG_MATCHED
        // Priority: MATCHED > WRONG_MATCHED
        const priority = entry.registerState === 'MATCHED' ? 2 : 1;
        const existingPriority = existing.state === 'MATCHED' ? 2 : 1;

        if (priority > existingPriority) {
          // Demote existing
          existing.entry.registerState = 'MISSING';
          existing.entry.matchedDocumentId = null;
          existing.entry.matchConfidence = null;
          existing.entry.matchFieldDetails = null;
          existing.entry.reviewCandidateTxnIds = [];
          transactionStates.set(entry.qboTxnId, { state: entry.registerState, entry });
        } else {
          // Demote current
          entry.registerState = 'MISSING';
          entry.matchedDocumentId = null;
          entry.matchConfidence = null;
          entry.matchFieldDetails = null;
          entry.reviewCandidateTxnIds = [];
        }
      }
    }
  }

  return entries;
}

function getStatePriority(state: QboRegisterState): number {
  const priorities: Record<QboRegisterState, number> = {
    'MATCHED': 4,
    'WRONG_MATCHED': 3,
    'REVIEW_REQUIRED': 2,
    'MISSING': 1,
  };
  return priorities[state] || 0;
}

function createRegisterEntry(entry: RegisterEntry): RegisterEntry {
  return entry;
}

/**
 * Find inbox document that corresponds to a QBO attachable
 * Match by filename or other metadata
 */
function findInboxDocumentForAttachable(attachable: any, inboxDocuments: any[]): any | null {
  // Try to match by filename
  for (const doc of inboxDocuments) {
    if (doc.filename === attachable.fileName) {
      return doc;
    }
  }
  return null;
}

/**
 * Populate the QBO evidence register for a realm and date range.
 * This is the function expected by the pipeline.
 */
export async function populateQboEvidenceRegister(
  realmId: string,
  startDate: string,
  endDate: string
): Promise<void> {
  // 1. Build the register entries
  const entries = await buildQboEvidenceRegister({
    realmId,
    startDate,
    endDate,
  });

  // 2. Persist the final register entries
  await persistRegisterEntries(entries, realmId);
}

/**
 * Persist register entries to database
 * Handles different entry shapes to work with the partial unique index:
 * - (realm_id, qbo_txn_id) WHERE qbo_txn_id IS NOT NULL
 */
export async function persistRegisterEntries(
  entries: RegisterEntry[],
  realmId: string
): Promise<void> {
  for (const entry of entries) {
    // Ensure realmId is set
    entry.realmId = realmId;

    // UUID fix: attachable_id must retain the raw QBO attachable ID as text
    // matched_document_id must contain only a genuine inbox_documents.id UUID or null
    // Never place synthetic values such as 'qbo-attachment-1000000671' into matched_document_id

    const payload = buildRegisterPayload(entry, realmId);

    if (entry.qboTxnId !== null) {
      // Entry has a QBO transaction ID - use RPC function for atomic upsert
      // The function uses ON CONFLICT (realm_id, qbo_txn_id) WHERE qbo_txn_id IS NOT NULL
      // matching the partial unique index: ux_qbo_evidence_register_one_per_txn
      const { data, error } = await supabaseAdmin.rpc('upsert_qbo_evidence_register_txn', {
        p_realm_id: payload.realm_id,
        p_collection_request_id: payload.collection_request_id,
        p_qbo_txn_id: payload.qbo_txn_id,
        p_qbo_txn_type: payload.qbo_txn_type,
        p_qbo_txn_date: payload.qbo_txn_date,
        p_qbo_txn_vendor: payload.qbo_txn_vendor,
        p_qbo_txn_amount: payload.qbo_txn_amount,
        p_qbo_txn_doc_number: payload.qbo_txn_doc_number,
        p_attachable_id: payload.attachable_id,
        p_attachment_filename: payload.attachment_filename,
        p_attachment_file_size: payload.attachment_file_size,
        p_attachment_download_url: payload.attachment_download_url,
        p_register_state: payload.register_state,
        p_matched_document_id: payload.matched_document_id,
        p_match_confidence: payload.match_confidence,
        p_match_field_details: payload.match_field_details,
        p_correct_qbo_txn_id: payload.correct_qbo_txn_id,
        p_review_candidate_txn_ids: payload.review_candidate_txn_ids,
        p_computed_at: payload.computed_at,
      });

      if (error) {
        throw new Error(`Failed to upsert register entry for qbo_txn_id=${entry.qboTxnId}: ${error.message}`);
      }
    } else if (entry.matchedDocumentId !== null) {
      // Document-side entry without qbo_txn_id but with matched_document_id
      // Use select-then-upsert pattern since no unique constraint covers this shape
      await upsertDocumentSideEntry(payload, entry.matchedDocumentId, realmId);
    } else if (entry.attachableId !== null) {
      // Orphaned attachable entry without qbo_txn_id but with attachable_id
      // Use select-then-upsert pattern since no unique constraint covers this shape
      await upsertAttachableSideEntry(payload, entry.attachableId, realmId);
    } else {
      // Entry with no reliable identity (no qbo_txn_id, no matched_document_id, no attachable_id)
      // Cannot safely upsert - insert only and accept potential duplicates on rerun
      const { error } = await supabaseAdmin
        .from('qbo_evidence_register')
        .insert(payload);

      if (error) {
        throw new Error(`Failed to insert register entry with no identity key: ${error.message}`);
      }
    }
  }
}

/**
 * Build the database payload from a RegisterEntry
 */
function buildRegisterPayload(entry: RegisterEntry, realmId: string) {
  return {
    realm_id: realmId,
    collection_request_id: entry.collectionRequestId,
    qbo_txn_id: entry.qboTxnId,
    qbo_txn_type: entry.qboTxnType,
    qbo_txn_date: entry.qboTxnDate,
    qbo_txn_vendor: entry.qboTxnVendor,
    qbo_txn_amount: entry.qboTxnAmount,
    qbo_txn_doc_number: entry.qboTxnDocNumber,
    attachable_id: entry.attachableId,
    attachment_filename: entry.attachmentFilename,
    attachment_file_size: entry.attachmentFileSize,
    attachment_download_url: entry.attachmentDownloadUrl,
    register_state: entry.registerState,
    matched_document_id: entry.matchedDocumentId,
    match_confidence: entry.matchConfidence,
    match_field_details: entry.matchFieldDetails,
    correct_qbo_txn_id: entry.correctQboTxnId,
    review_candidate_txn_ids: entry.reviewCandidateTxnIds,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Upsert a document-side entry (matched_document_id present, qbo_txn_id null)
 * Uses select-then-update/insert since no unique constraint covers this shape
 */
async function upsertDocumentSideEntry(
  payload: any,
  matchedDocumentId: string,
  realmId: string
): Promise<void> {
  // Try to find existing entry with same realm_id and matched_document_id AND null qbo_txn_id
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('qbo_evidence_register')
    .select('id')
    .eq('realm_id', realmId)
    .eq('matched_document_id', matchedDocumentId)
    .is('qbo_txn_id', null)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to check existing document-side entry for matched_document_id=${matchedDocumentId}: ${selectError.message}`);
  }

  if (existing) {
    // Update existing
    const { error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .update(payload)
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update document-side entry for matched_document_id=${matchedDocumentId}: ${error.message}`);
    }
  } else {
    // Insert new
    const { error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .insert(payload);

    if (error) {
      throw new Error(`Failed to insert document-side entry for matched_document_id=${matchedDocumentId}: ${error.message}`);
    }
  }
}

/**
 * Upsert an attachable-side entry (attachable_id present, qbo_txn_id null)
 * Uses select-then-update/insert since no unique constraint covers this shape
 */
async function upsertAttachableSideEntry(
  payload: any,
  attachableId: string,
  realmId: string
): Promise<void> {
  // Try to find existing entry with same realm_id and attachable_id (and null qbo_txn_id)
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('qbo_evidence_register')
    .select('id')
    .eq('realm_id', realmId)
    .eq('attachable_id', attachableId)
    .is('qbo_txn_id', null)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to check existing attachable-side entry for attachable_id=${attachableId}: ${selectError.message}`);
  }

  if (existing) {
    // Update existing
    const { error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .update(payload)
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update attachable-side entry for attachable_id=${attachableId}: ${error.message}`);
    }
  } else {
    // Insert new
    const { error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .insert(payload);

    if (error) {
      throw new Error(`Failed to insert attachable-side entry for attachable_id=${attachableId}: ${error.message}`);
    }
  }
}

/**
 * Get register entries from database
 * Updated to accept 4 arguments: realmId, collectionRequestId, startDate, endDate
 * Applies date filters to qbo_txn_date when supplied
 */
export async function getRegisterEntries(
  realmId: string,
  collectionRequestId?: string,
  startDate?: string,
  endDate?: string
): Promise<RegisterEntry[]> {
  let query = supabaseAdmin
    .from('qbo_evidence_register')
    .select('*')
    .eq('realm_id', realmId)
    .order('qbo_txn_date', { ascending: true });

  if (collectionRequestId) {
    query = query.eq('collection_request_id', collectionRequestId);
  }

  if (startDate) {
    query = query.gte('qbo_txn_date', startDate);
  }

  if (endDate) {
    query = query.lte('qbo_txn_date', endDate);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Failed to fetch register entries: ${error.message}`);

  return (data || []).map(row => ({
    realmId: row.realm_id,
    collectionRequestId: row.collection_request_id,
    qboTxnId: row.qbo_txn_id,
    qboTxnType: row.qbo_txn_type,
    qboTxnDate: row.qbo_txn_date,
    qboTxnVendor: row.qbo_txn_vendor,
    qboTxnAmount: row.qbo_txn_amount,
    qboTxnDocNumber: row.qbo_txn_doc_number,
    attachableId: row.attachable_id,
    attachmentFilename: row.attachment_filename,
    attachmentFileSize: row.attachment_file_size,
    attachmentDownloadUrl: row.attachment_download_url,
    registerState: row.register_state as QboRegisterState,
    matchedDocumentId: row.matched_document_id,
    matchConfidence: row.match_confidence,
    matchFieldDetails: row.match_field_details,
    correctQboTxnId: row.correct_qbo_txn_id,
    reviewCandidateTxnIds: row.review_candidate_txn_ids || [],
  }));
}

/**
 * Update the QBO evidence register for a single document after it's been processed.
 * This reuses the existing matching logic and updates the register state accordingly.
 *
 * @param documentId - The inbox document ID that was processed
 * @param realmId - The realm ID
 * @param collectionRequestId - The collection request ID
 * @param matchResult - The match result from processInboxDocument
 * @param docFields - The extracted document fields
 * @param isDuplicate - Legacy parameter (unused in 4-state model)
 * @param duplicateOfDocumentId - Legacy parameter (unused in 4-state model)
 * @returns The updated register entry for this document, or null if no change
 */
export async function updateRegisterForDocument(
  documentId: string,
  realmId: string,
  collectionRequestId: string | undefined,
  matchResult: MatchResult,
  docFields: ExtractedDocumentFields,
  isDuplicate?: boolean | null, // Legacy - DUPLICATE state removed in 4-state model
  duplicateOfDocumentId?: string | null // Legacy - DUPLICATE state removed in 4-state model
): Promise<RegisterEntry | null> {
  // Fetch existing register entries for this realm to check current state
  const existingEntries = await getRegisterEntries(realmId, collectionRequestId);

  // Check if this document is already in the register
  const existingEntry = existingEntries.find(e =>
    e.matchedDocumentId === documentId
  );

  // Determine the new register state based on match result
  // Automatic matcher produces only MATCHED, REVIEW_REQUIRED, or leaves as MISSING
  let newState: QboRegisterState = 'MISSING';
  let qboTxnId: string | null = null;
  let matchedTransaction: QBOTransaction | undefined;
  let reviewCandidateTxnIds: string[] = [];

  if (matchResult.status === 'matched') {
    newState = 'MATCHED';
    qboTxnId = matchResult.transactionId!;
    matchedTransaction = matchResult.matchedTransaction;
  } else if (matchResult.status === 'multiple_candidates') {
    newState = 'REVIEW_REQUIRED';
    qboTxnId = matchResult.allCandidates?.[0]?.txnId ?? null;
    matchedTransaction = matchResult.allCandidates?.[0];
    reviewCandidateTxnIds = matchResult.allCandidates?.map(c => c.txnId) ?? [];
  } else {
    // No match - transaction remains MISSING
    newState = 'MISSING';
    qboTxnId = null;
    matchedTransaction = undefined;
  }

  // Check for existing MISSING entry for this transaction to upgrade to MATCHED or REVIEW_REQUIRED
  // MISSING entries can have collection_request_id = NULL, so we must query without that filter
  // This check runs FIRST when matchResult.status === 'matched' or 'multiple_candidates' to prefer upgrading MISSING over creating new rows
  if ((matchResult.status === 'matched' || matchResult.status === 'multiple_candidates') && qboTxnId) {
    const { data: missingData, error: missingError } = await supabaseAdmin
      .from('qbo_evidence_register')
      .select('*')
      .eq('realm_id', realmId)
      .eq('qbo_txn_id', qboTxnId)
      .eq('register_state', 'MISSING')
      .maybeSingle();

    if (!missingError && missingData) {
      // Found a MISSING entry - upgrade it instead of creating/updating a document entry
      const newRegisterState = matchResult.status === 'matched' ? 'MATCHED' : 'REVIEW_REQUIRED';
      const { error } = await supabaseAdmin
        .from('qbo_evidence_register')
        .update({
          register_state: newRegisterState,
          match_confidence: matchResult.confidence,
          match_field_details: matchResult.candidateDetails || null,
          matched_document_id: documentId,
          review_candidate_txn_ids: newRegisterState === 'REVIEW_REQUIRED' ? reviewCandidateTxnIds : [],
          computed_at: new Date().toISOString(),
        })
        .eq('id', missingData.id);

      if (error) {
        console.error(`Failed to update MISSING entry to ${newRegisterState} for document ${documentId}:`, error.message);
        return null;
      }

      // If there was an existing entry for this document, delete it to avoid duplicate
      if (existingEntry) {
        await supabaseAdmin
          .from('qbo_evidence_register')
          .delete()
          .eq('id', existingEntry.id);
      }

      return {
        id: missingData.id,
        realmId: missingData.realm_id,
        collectionRequestId: missingData.collection_request_id,
        qboTxnId: missingData.qbo_txn_id,
        qboTxnType: missingData.qbo_txn_type,
        qboTxnDate: missingData.qbo_txn_date,
        qboTxnVendor: missingData.qbo_txn_vendor,
        qboTxnAmount: missingData.qbo_txn_amount,
        qboTxnDocNumber: missingData.qbo_txn_doc_number,
        attachableId: missingData.attachable_id,
        attachmentFilename: missingData.attachment_filename,
        attachmentFileSize: missingData.attachment_file_size,
        attachmentDownloadUrl: missingData.attachment_download_url,
        registerState: newRegisterState,
        matchConfidence: matchResult.confidence,
        matchFieldDetails: matchResult.candidateDetails || null,
        matchedDocumentId: documentId,
        correctQboTxnId: missingData.correct_qbo_txn_id,
        reviewCandidateTxnIds: newRegisterState === 'REVIEW_REQUIRED' ? reviewCandidateTxnIds : [],
      } as RegisterEntry;
    }
  }

  // If there's an existing entry for this document, check if we should update
  if (existingEntry) {
    // Preserve MATCHED state if already resolved
    if (existingEntry.registerState === 'MATCHED' && newState !== 'MATCHED') {
      // Don't downgrade a MATCHED document
      return null;
    }

    // Preserve WRONG_MATCHED (proven incorrect pre-existing attachment)
    if (existingEntry.registerState === 'WRONG_MATCHED') {
      return null;
    }

    // Update the existing entry
    // Note: newState here can only be MATCHED, MISSING, or REVIEW_REQUIRED
    // WRONG_MATCHED is only assigned later for new entries
    const { error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .update({
        register_state: newState,
        match_confidence: matchResult.confidence,
        match_field_details: matchResult.candidateDetails || null,
        matched_document_id: newState === 'MATCHED' || newState === 'REVIEW_REQUIRED' ? documentId : null,
        qbo_txn_id: qboTxnId,
        qbo_txn_type: matchedTransaction?.txnType ?? null,
        qbo_txn_date: matchedTransaction?.date ?? null,
        qbo_txn_vendor: matchedTransaction?.vendor ?? null,
        qbo_txn_amount: matchedTransaction?.amount ?? null,
        qbo_txn_doc_number: matchedTransaction?.docNumber ?? null,
        correct_qbo_txn_id: null,
        review_candidate_txn_ids: newState === 'REVIEW_REQUIRED' ? reviewCandidateTxnIds : [],
        computed_at: new Date().toISOString(),
      })
      .eq('id', existingEntry.id);

    if (error) {
      console.error(`Failed to update register entry for document ${documentId}:`, error.message);
      return null;
    }

    return { ...existingEntry, registerState: newState, reviewCandidateTxnIds };
  }

  // Check if the matched transaction already has a MATCHED entry with a different document
  // This would make this document WRONG_MATCHED (proven incorrect pre-existing attachment)
  if (matchResult.status === 'matched' && matchResult.transactionId) {
    const conflictingEntry = existingEntries.find(e =>
      e.qboTxnId === matchResult.transactionId &&
      e.registerState === 'MATCHED' &&
      e.matchedDocumentId !== documentId
    );

    if (conflictingEntry) {
      // This transaction is already MATCHED with a different document
      // Mark this document as WRONG_MATCHED - proven incorrect pre-existing attachment
      newState = 'WRONG_MATCHED';
      qboTxnId = conflictingEntry.qboTxnId ?? null;
      matchedTransaction = conflictingEntry as any;
    }
  }

  // Create new register entry
  const newEntry: RegisterEntry = {
    realmId,
    collectionRequestId: collectionRequestId ?? null,
    qboTxnId,
    qboTxnType: matchedTransaction?.txnType ?? null,
    qboTxnDate: matchedTransaction?.date ?? null,
    qboTxnVendor: matchedTransaction?.vendor ?? null,
    qboTxnAmount: matchedTransaction?.amount ?? null,
    qboTxnDocNumber: matchedTransaction?.docNumber ?? null,
    attachableId: null, // Client documents don't have QBO attachable IDs
    attachmentFilename: null, // Will be filled from document
    attachmentFileSize: null,
    attachmentDownloadUrl: null,
    registerState: newState,
    matchedDocumentId: newState === 'MATCHED' || newState === 'REVIEW_REQUIRED' || newState === 'WRONG_MATCHED' ? documentId : null,
    matchConfidence: matchResult.confidence,
    matchFieldDetails: matchResult.candidateDetails ?? null,
    correctQboTxnId: newState === 'WRONG_MATCHED' ? matchResult.transactionId ?? null : null,
    reviewCandidateTxnIds: newState === 'REVIEW_REQUIRED' ? reviewCandidateTxnIds : [],
  };

  // Persist the new entry using strategy appropriate for the entry shape
  // The partial unique index is: (realm_id, qbo_txn_id) WHERE qbo_txn_id IS NOT NULL
  const payload = {
    realm_id: realmId,
    collection_request_id: newEntry.collectionRequestId,
    qbo_txn_id: newEntry.qboTxnId,
    qbo_txn_type: newEntry.qboTxnType,
    qbo_txn_date: newEntry.qboTxnDate,
    qbo_txn_vendor: newEntry.qboTxnVendor,
    qbo_txn_amount: newEntry.qboTxnAmount,
    qbo_txn_doc_number: newEntry.qboTxnDocNumber,
    attachable_id: newEntry.attachableId,
    attachment_filename: newEntry.attachmentFilename,
    attachment_file_size: newEntry.attachmentFileSize,
    attachment_download_url: newEntry.attachmentDownloadUrl,
    register_state: newEntry.registerState,
    matched_document_id: newEntry.matchedDocumentId,
    match_confidence: newEntry.matchConfidence,
    match_field_details: newEntry.matchFieldDetails,
    correct_qbo_txn_id: newEntry.correctQboTxnId,
    review_candidate_txn_ids: newEntry.reviewCandidateTxnIds,
    computed_at: new Date().toISOString(),
  };

  if (newEntry.qboTxnId !== null) {
    // Entry has a QBO transaction ID - use RPC function for atomic upsert
    // The function uses ON CONFLICT (realm_id, qbo_txn_id) WHERE qbo_txn_id IS NOT NULL
    // matching the partial unique index: ux_qbo_evidence_register_one_per_txn
    const { data, error } = await supabaseAdmin.rpc('upsert_qbo_evidence_register_txn', {
      p_realm_id: payload.realm_id,
      p_collection_request_id: payload.collection_request_id,
      p_qbo_txn_id: payload.qbo_txn_id,
      p_qbo_txn_type: payload.qbo_txn_type,
      p_qbo_txn_date: payload.qbo_txn_date,
      p_qbo_txn_vendor: payload.qbo_txn_vendor,
      p_qbo_txn_amount: payload.qbo_txn_amount,
      p_qbo_txn_doc_number: payload.qbo_txn_doc_number,
      p_attachable_id: payload.attachable_id,
      p_attachment_filename: payload.attachment_filename,
      p_attachment_file_size: payload.attachment_file_size,
      p_attachment_download_url: payload.attachment_download_url,
      p_register_state: payload.register_state,
      p_matched_document_id: payload.matched_document_id,
      p_match_confidence: payload.match_confidence,
      p_match_field_details: payload.match_field_details,
      p_correct_qbo_txn_id: payload.correct_qbo_txn_id,
      p_review_candidate_txn_ids: payload.review_candidate_txn_ids,
      p_computed_at: payload.computed_at,
    });

    if (error) {
      throw new Error(`Failed to upsert register entry for document ${documentId} (qbo_txn_id=${newEntry.qboTxnId}): ${error.message}`);
    }
  } else if (newEntry.matchedDocumentId !== null) {
    // Document-side entry without qbo_txn_id but with matched_document_id
    // Use select-then-upsert pattern since no unique constraint covers this shape
    await upsertDocumentSideEntry(payload, newEntry.matchedDocumentId, realmId);
  } else {
    // Entry with no reliable identity (MISSING without qbo_txn_id or matched_document_id)
    // Cannot safely upsert - insert only and accept potential duplicates on rerun
    const { error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .insert(payload);

    if (error) {
      throw new Error(`Failed to insert register entry for document ${documentId} with no identity key: ${error.message}`);
    }
  }

  return newEntry;
}