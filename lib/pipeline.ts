/**
 * Phase 8 — End-to-End Pipeline Orchestration
 *
 * Orchestrates the complete audit package generation workflow by reusing
 * existing verified components from Phases 1-7.
 */

import {
  getTransactions,
  getAttachables,
  normalizeTransactionList,
  normalizeAttachables,
  downloadFile,
} from './quickbooks';

import {
  populateQboEvidenceRegister,
  getRegisterEntries,
  updateRegisterForDocument,
} from './qbo-evidence-register';

import { generateAndSaveCsvs, splitEvidenceRegister } from './output';

import { generateZip } from './zip';

import {
  processCollectionRequestDocuments,
  downloadDocument,
} from './document-extraction';

import { supabaseAdmin } from './supabase-admin';

export interface PipelineResult {
  success: boolean;
  zipPath?: string;
  error?: {
    stage: string;
    reason: string;
    details?: any;
  };
  stats: {
    transactionCount: number;
    attachableCount: number;
    matchedCount: number;
    missingCount: number;
    successfulDownloadCount: number;
    failedDownloadCount: number;
    zipSizeBytes: number;
    elapsedTimeMs: number;
  };
}

export interface PipelineProgress {
  stage: string;
  status: 'started' | 'in_progress' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  counts?: Record<string, number>;
}

/**
 * Sanitize a filename by replacing invalid characters with underscores.
 * Handles path separators and Windows/Linux invalid filename characters.
 */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Build a deterministic ZIP filename for a QBO-side-only attachment.
 * Uses available transaction metadata and the original attachment filename.
 * Format: {txnType}_{txnId}_{vendor}_{date}_{sanitizedFilename}
 * Missing fields are omitted (not invented).
 */
function buildQboZipFileName(
  entry: {
    txnType: string | null;
    qboTxnId: string | null;
    vendor: string | null;
    date: string | null;
  },
  sanitizedFileName: string
): string {
  const parts: string[] = [];

  if (entry.txnType) parts.push(entry.txnType);
  if (entry.qboTxnId) parts.push(entry.qboTxnId);
  if (entry.vendor) parts.push(sanitizeFileName(entry.vendor));
  if (entry.date) parts.push(entry.date.replace(/-/g, '')); // YYYYMMDD format

  const prefix = parts.length > 0 ? parts.join('_') + '_' : '';
  return `${prefix}${sanitizedFileName}`;
}

/**
 * Main end-to-end pipeline function.
 *
 * @param companyId - Company identifier (realm ID)
 * @param startDate - Start date in YYYY-MM-DD format
 * @param endDate - End date in YYYY-MM-DD format
 * @returns PipelineResult with success status, ZIP path, and statistics
 */
export async function generatePackage(
  companyId: string,
  startDate: string,
  endDate: string
): Promise<PipelineResult> {
  const startTime = Date.now();
  const progressLog: PipelineProgress[] = [];

  const stats = {
    transactionCount: 0,
    attachableCount: 0,
    matchedCount: 0,
    missingCount: 0,
    successfulDownloadCount: 0,
    failedDownloadCount: 0,
    zipSizeBytes: 0,
    elapsedTimeMs: 0,
  };

  const logProgress = (
    stage: string,
    status: 'started' | 'in_progress' | 'completed' | 'failed',
    message: string,
    counts?: Record<string, number>
  ) => {
    const entry: PipelineProgress = {
      stage,
      status,
      message,
      timestamp: new Date().toISOString(),
      counts,
    };

    progressLog.push(entry);

    const prefix =
      status === 'started' ? '▶' : status === 'completed' ? '✓' : '✗';

    console.log(
      `${prefix} [${entry.timestamp}] ${stage}: ${message}${
        counts ? ` (${JSON.stringify(counts)})` : ''
      }`
    );
  };

  const handleFailure = (
    stage: string,
    reason: string,
    details?: any
  ): PipelineResult => {
    logProgress(stage, 'failed', reason, details);

    return {
      success: false,
      error: { stage, reason, details },
      stats: { ...stats, elapsedTimeMs: Date.now() - startTime },
    };
  };

  try {
    // ========================================================================
    // STAGE 1: Transaction Retrieval
    // ========================================================================

    logProgress(
      'Transaction Retrieval',
      'started',
      'Fetching transactions from QuickBooks'
    );

    let rawTransactions: any;

    try {
      rawTransactions = await getTransactions(startDate, endDate);
    } catch (e: any) {
      return handleFailure(
        'Transaction Retrieval',
        `Failed to retrieve transactions: ${e.message}`,
        { error: e.message }
      );
    }

    const transactions = normalizeTransactionList(rawTransactions);
    stats.transactionCount = transactions.length;

    logProgress(
      'Transaction Retrieval',
      'completed',
      `Retrieved ${stats.transactionCount} transactions`,
      {
        transactionCount: stats.transactionCount,
      }
    );

    // ========================================================================
    // STAGE 2: Attachable Retrieval
    // ========================================================================

    logProgress(
      'Attachable Retrieval',
      'started',
      'Fetching attachables from QuickBooks'
    );

    let rawAttachables: any;

    try {
      rawAttachables = await getAttachables();
    } catch (e: any) {
      return handleFailure(
        'Attachable Retrieval',
        `Failed to retrieve attachables: ${e.message}`,
        { error: e.message }
      );
    }

    const attachables = normalizeAttachables(rawAttachables);
    stats.attachableCount = attachables.length;

    logProgress(
      'Attachable Retrieval',
      'completed',
      `Retrieved ${stats.attachableCount} attachables`,
      {
        attachableCount: stats.attachableCount,
      }
    );

    // ========================================================================
    // STAGE 3: Evidence Register Matching
    // ========================================================================

    logProgress(
      'Evidence Register Matching',
      'started',
      'Building QBO evidence register'
    );

    let register: any[];

    try {
      await populateQboEvidenceRegister(companyId, startDate, endDate);

      const entries = await getRegisterEntries(
        companyId,
        undefined,
        startDate,
        endDate
      );

      register = entries.map((entry) => ({
        txnId: entry.qboTxnId,
        qboTxnId: entry.qboTxnId,
        txnType: entry.qboTxnType,
        date: entry.qboTxnDate,
        vendor: entry.qboTxnVendor,
        amount: entry.qboTxnAmount,
        docNumber: entry.qboTxnDocNumber,
        attachableId: entry.attachableId,
        fileName: entry.attachmentFilename,
        fileSize: entry.attachmentFileSize,
        downloadUrl: entry.attachmentDownloadUrl,
        entityType: null,
        entityId: null,
        orphaned: entry.registerState === 'WRONG_MATCHED',
        hasAttachment: !!entry.attachmentFilename,
        registerState: entry.registerState,
        matchedDocumentId: entry.matchedDocumentId,
        matchConfidence: entry.matchConfidence,
        matchFieldDetails: entry.matchFieldDetails,
        correctQboTxnId: entry.correctQboTxnId,
        reviewCandidateTxnIds: entry.reviewCandidateTxnIds,
      }));
    } catch (e: any) {
      return handleFailure(
        'Evidence Register Matching',
        `Failed to build QBO evidence register: ${e.message}`,
        { error: e.message }
      );
    }

    const { missingEntries } = splitEvidenceRegister(register);

    stats.matchedCount = register.filter(
      (e) => e.registerState === 'MATCHED'
    ).length;

    stats.missingCount = missingEntries.length;

    logProgress(
      'Evidence Register Matching',
      'completed',
      `Matched: ${stats.matchedCount} Missing: ${stats.missingCount}`,
      {
        matchedCount: stats.matchedCount,
        missingCount: stats.missingCount,
      }
    );

    // ========================================================================
    // STEP 1: Process inbox documents and update evidence register
    // ========================================================================

    logProgress(
      'Inbox Document Processing',
      'started',
      'Processing uploaded documents and updating evidence register'
    );

    try {
      const { data: inboxDocuments, error: docsError } = await supabaseAdmin
        .from('inbox_documents')
        .select('id')
        .eq('realm_id', companyId)
        .is('processed_at', null);

      if (docsError) {
        throw new Error(
          `Failed to fetch inbox documents: ${docsError.message}`
        );
      }

      // Fetch a collection request for this company to pass to processing
      const { data: collectionRequest } = await supabaseAdmin
        .from('collection_requests')
        .select('id')
        .eq('realm_id', companyId)
        .limit(1)
        .single();

      const collectionRequestId = collectionRequest?.id;

      const allProcessingResults: {
        documentId: string;
        matchResult: any;
        extractedFields: any;
      }[] = [];

      if (collectionRequestId) {
        const results =
          await processCollectionRequestDocuments(collectionRequestId);

        for (const result of results) {
          const { matchResult, extractedFields } = result;

          if (result.isDuplicate) {
            continue;
          }

          await updateRegisterForDocument(
            matchResult.documentId,
            companyId,
            collectionRequestId,
            matchResult,
            extractedFields
          );

          allProcessingResults.push({
            documentId: matchResult.documentId,
            matchResult,
            extractedFields,
          });
        }
      } else {
        console.log('No collection request found for company, skipping inbox document processing');
      }

      const updatedEntries = await getRegisterEntries(
        companyId,
        undefined,
        startDate,
        endDate
      );

      register = updatedEntries.map((entry) => ({
        txnId: entry.qboTxnId,
        qboTxnId: entry.qboTxnId,
        txnType: entry.qboTxnType,
        date: entry.qboTxnDate,
        vendor: entry.qboTxnVendor,
        amount: entry.qboTxnAmount,
        docNumber: entry.qboTxnDocNumber,
        attachableId: entry.attachableId,
        fileName: entry.attachmentFilename,
        fileSize: entry.attachmentFileSize,
        downloadUrl: entry.attachmentDownloadUrl,
        entityType: null,
        entityId: null,
        orphaned: entry.registerState === 'WRONG_MATCHED',
        hasAttachment: !!entry.attachmentFilename,
        registerState: entry.registerState,
        matchedDocumentId: entry.matchedDocumentId,
        matchConfidence: entry.matchConfidence,
        matchFieldDetails: entry.matchFieldDetails,
        correctQboTxnId: entry.correctQboTxnId,
        reviewCandidateTxnIds: entry.reviewCandidateTxnIds,
      }));

      logProgress(
        'Inbox Document Processing',
        'completed',
        `Processed ${allProcessingResults.length} documents`,
        {
          processedCount: allProcessingResults.length,
        }
      );
    } catch (e: any) {
      return handleFailure(
        'Inbox Document Processing',
        `Failed to process inbox documents: ${e.message}`,
        { error: e.message }
      );
    }

    // ========================================================================
    // STAGE 4: Evidence Document Download
    // ========================================================================

    const entriesWithEvidence = register.filter(
      (e) =>
        e.registerState !== 'MISSING' &&
        e.matchedDocumentId !== null &&
        e.matchedDocumentId !== undefined
    );

    const uniqueEvidenceDocumentIds = Array.from(
      new Set(
        entriesWithEvidence.map((entry) => String(entry.matchedDocumentId))
      )
    );

    logProgress(
      'Evidence Document Download',
      'started',
      `Downloading ${uniqueEvidenceDocumentIds.length} evidence documents`
    );

    let downloadResult: {
      successfulCount: number;
      failedCount: number;
      successful: {
        matchedDocumentId: string;
        fileName: string;
        buffer: Buffer;
      }[];
    };

    try {
      const successfulDownloads: {
        matchedDocumentId: string;
        fileName: string;
        buffer: Buffer;
      }[] = [];

      let failedCount = 0;

      for (const matchedDocumentId of uniqueEvidenceDocumentIds) {
        try {
          const { data: docRecord, error: docError } = await supabaseAdmin
            .from('inbox_documents')
            .select('storage_path, filename')
            .eq('id', matchedDocumentId)
            .single();

          if (docError || !docRecord) {
            console.warn(
              `Inbox document not found for ID: ${matchedDocumentId}`
            );
            failedCount++;
            continue;
          }

          const buffer = await downloadDocument(docRecord.storage_path);

          if (buffer.length === 0) {
            console.warn(
              `Empty document downloaded for ID: ${matchedDocumentId}`
            );
            failedCount++;
            continue;
          }

          successfulDownloads.push({
            matchedDocumentId,
            fileName: docRecord.filename,
            buffer,
          });
        } catch (docError: unknown) {
          const message =
            docError instanceof Error ? docError.message : String(docError);

          console.warn(
            `Failed to download document ${matchedDocumentId}:`,
            message
          );

          failedCount++;
        }
      }

      downloadResult = {
        successfulCount: successfulDownloads.length,
        failedCount,
        successful: successfulDownloads,
      };
    } catch (e: any) {
      return handleFailure(
        'Evidence Document Download',
        `Failed to download evidence documents: ${e.message}`,
        { error: e.message }
      );
    }

    stats.successfulDownloadCount = downloadResult.successfulCount;
    stats.failedDownloadCount = downloadResult.failedCount;

    let successfulEvidenceFiles = downloadResult.successful;

    // ========================================================================
    // STAGE 4b: QBO-Side-Only Attachment Download
    // ========================================================================

    // Identify QBO-side-only attachments: registerState in MATCHED/WRONG_MATCHED/REVIEW_REQUIRED,
    // attachableId is non-null, matchedDocumentId is null
    const qboSideOnlyCandidates = register.filter(
      (e) =>
        (e.registerState === 'MATCHED' ||
          e.registerState === 'WRONG_MATCHED' ||
          e.registerState === 'REVIEW_REQUIRED') &&
        e.attachableId !== null &&
        e.attachableId !== undefined &&
        (e.matchedDocumentId === null || e.matchedDocumentId === undefined)
    );

    // Deduplicate by attachableId
    const uniqueQboAttachables = new Map<string, typeof qboSideOnlyCandidates[0]>();
    for (const candidate of qboSideOnlyCandidates) {
      if (candidate.attachableId && !uniqueQboAttachables.has(candidate.attachableId)) {
        uniqueQboAttachables.set(candidate.attachableId, candidate);
      }
    }

    const qboAttachablesToDownload = Array.from(uniqueQboAttachables.values());

    if (qboAttachablesToDownload.length > 0) {
      logProgress(
        'QBO-Side-Only Attachment Download',
        'started',
        `Downloading ${qboAttachablesToDownload.length} QBO-side-only attachments`
      );

      // Create temporary directory for downloads
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs');
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditready-qbo-attachments-'));

      let qboSuccessCount = 0;
      let qboFailedCount = 0;
      const qboFailedDownloads: { attachableId: string; error: string }[] = [];

      try {
        for (const entry of qboAttachablesToDownload) {
          const attachableId = entry.attachableId!;
          const originalFileName = entry.fileName || `attachment_${attachableId}`;

          try {
            // Download using existing downloadFile helper
            const result = await downloadFile(attachableId, originalFileName, tempDir);

            if (result.success && result.filePath) {
              // Read the downloaded file into Buffer
              const buffer = fs.readFileSync(result.filePath);

              if (buffer.length > 0) {
                // Build safe deterministic ZIP filename from transaction metadata + original filename
                const sanitizedFileName = sanitizeFileName(originalFileName);
                const zipFileName = buildQboZipFileName(entry, sanitizedFileName);

                // Add to successfulEvidenceFiles with synthetic matchedDocumentId
                successfulEvidenceFiles.push({
                  matchedDocumentId: `qbo-${attachableId}`,
                  fileName: zipFileName,
                  buffer,
                });

                qboSuccessCount++;
              } else {
                console.warn(`Empty file downloaded for attachable ${attachableId}`);
                qboFailedCount++;
                qboFailedDownloads.push({ attachableId, error: 'Empty file downloaded' });
              }
            } else {
              const errorMsg = result.error || 'Download failed';
              console.warn(`Failed to download attachable ${attachableId}: ${errorMsg}`);
              qboFailedCount++;
              qboFailedDownloads.push({ attachableId, error: errorMsg });
            }
          } catch (downloadError: unknown) {
            const errorMsg = downloadError instanceof Error ? downloadError.message : String(downloadError);
            console.warn(`Exception downloading attachable ${attachableId}: ${errorMsg}`);
            qboFailedCount++;
            qboFailedDownloads.push({ attachableId, error: errorMsg });
          }
        }

        // Update stats with QBO-side downloads
        stats.successfulDownloadCount += qboSuccessCount;
        stats.failedDownloadCount += qboFailedCount;

        logProgress(
          'QBO-Side-Only Attachment Download',
          'completed',
          `Downloaded ${qboSuccessCount} successful, ${qboFailedCount} failed`,
          {
            successfulCount: qboSuccessCount,
            failedCount: qboFailedCount,
          }
        );

        // Report failed downloads
        if (qboFailedDownloads.length > 0) {
          console.log('\n--- QBO-Side-Only Attachment Download Failures ---');
          for (const failure of qboFailedDownloads) {
            console.log(`  Attachable ID: ${failure.attachableId} | Error: ${failure.error}`);
          }
          console.log('----------------------------------------------------\n');
        }
      } finally {
        // Clean up temporary directory
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn(`Failed to clean up temp directory ${tempDir}:`, cleanupError);
        }
      }
    } else {
      logProgress(
        'QBO-Side-Only Attachment Download',
        'completed',
        'No QBO-side-only attachments to download'
      );
    }

    logProgress(
      'Evidence Document Download',
      'completed',
      `Downloaded ${stats.successfulDownloadCount} successful, ${stats.failedDownloadCount} failed`,
      {
        successfulCount: stats.successfulDownloadCount,
        failedCount: stats.failedDownloadCount,
      }
    );

    // ========================================================================
    // STAGE 5: Evidence CSV Generation
    // ========================================================================

    logProgress(
      'Evidence CSV Generation',
      'started',
      'Generating evidence_register.csv'
    );

    let csvResult: any;

    try {
      csvResult = await generateAndSaveCsvs(
        register,
        companyId,
        startDate,
        endDate
      );
    } catch (e: any) {
      return handleFailure(
        'Evidence CSV Generation',
        `Failed to generate CSVs: ${e.message}`,
        { error: e.message }
      );
    }

    logProgress(
      'Evidence CSV Generation',
      'completed',
      'CSVs generated and saved',
      {
        evidenceRegisterPath: csvResult.evidenceRegisterPath,
        missingDocumentsPath: csvResult.missingDocumentsPath,
        matchedCount: csvResult.matchedCount,
        missingCount: csvResult.missingCount,
      }
    );

    // ========================================================================
    // STAGE 6: ZIP Generation
    // ========================================================================

    logProgress(
      'ZIP Generation',
      'started',
      'Creating audit package ZIP'
    );

    let zipPath: string;

    try {
      zipPath = await generateZip(
        companyId,
        startDate,
        endDate,
        successfulEvidenceFiles
      );
    } catch (e: any) {
      return handleFailure(
        'ZIP Generation',
        `Failed to generate ZIP: ${e.message}`,
        { error: e.message }
      );
    }

    const fs = await import('fs');
    const zipStat = fs.statSync(zipPath);
    stats.zipSizeBytes = zipStat.size;

    logProgress(
      'ZIP Generation',
      'completed',
      `ZIP created: ${zipPath} (${stats.zipSizeBytes} bytes)`,
      {
        zipSizeBytes: stats.zipSizeBytes,
      }
    );

    // ========================================================================
    // STAGE 7: Final Package Completion
    // ========================================================================

    stats.elapsedTimeMs = Date.now() - startTime;

    logProgress(
      'Pipeline Complete',
      'completed',
      `End-to-end pipeline completed in ${stats.elapsedTimeMs}ms`,
      {
        elapsedTimeMs: stats.elapsedTimeMs,
        transactionCount: stats.transactionCount,
        attachableCount: stats.attachableCount,
        matchedCount: stats.matchedCount,
        missingCount: stats.missingCount,
        successfulDownloadCount: stats.successfulDownloadCount,
        failedDownloadCount: stats.failedDownloadCount,
        zipSizeBytes: stats.zipSizeBytes,
      }
    );

    console.log('\n=== PIPELINE SUMMARY ===');
    console.log(`Transactions Retrieved: ${stats.transactionCount}`);
    console.log(`Attachables Retrieved: ${stats.attachableCount}`);
    console.log(`Matched Records: ${stats.matchedCount}`);
    console.log(`Missing Records: ${stats.missingCount}`);
    console.log(`Successful Downloads: ${stats.successfulDownloadCount}`);
    console.log(`Failed Downloads: ${stats.failedDownloadCount}`);
    console.log(`ZIP Size: ${stats.zipSizeBytes} bytes`);
    console.log(`Total Runtime: ${stats.elapsedTimeMs}ms`);
    console.log(`ZIP Path: ${zipPath}`);
    console.log('========================\n');

    return {
      success: true,
      zipPath,
      stats,
    };
  } catch (e: any) {
    stats.elapsedTimeMs = Date.now() - startTime;

    logProgress(
      'Pipeline',
      'failed',
      `Unexpected error: ${e.message}`,
      { error: e.message }
    );

    return {
      success: false,
      error: {
        stage: 'Pipeline',
        reason: `Unexpected error: ${e.message}`,
        details: e,
      },
      stats,
    };
  }
}

/**
 * Run the pipeline with a specific date range that works with the sandbox data.
 */
export async function runSandboxPipeline(): Promise<PipelineResult> {
  const companyId =
    process.env.INTUIT_REALM_ID || 'sandbox_company';

  const startDate = '2023-01-01';
  const endDate = '2023-12-31';

  console.log(`\n=== Starting Sandbox Pipeline Run ===`);
  console.log(`Company: ${companyId}`);
  console.log(`Date Range: ${startDate} to ${endDate}\n`);

  return generatePackage(companyId, startDate, endDate);
}