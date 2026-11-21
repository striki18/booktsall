import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  storageDownload: vi.fn(),
  getAttachables: vi.fn(),
  normalizeAttachables: vi.fn(),
  uploadFirstEvidenceItemToQbo: vi.fn(),
  calls: new Map<string, number>(),
  inserted: [] as Array<Record<string, unknown>>,
  initialItem: null as Record<string, unknown> | null,
  latestItem: null as Record<string, unknown> | null,
  register: null as Record<string, unknown> | null,
  existingItems: [] as Array<Record<string, unknown>>,
  document: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: mocks.from,
    storage: { from: () => ({ download: mocks.storageDownload }) },
  },
}));
vi.mock('@/lib/quickbooks', () => ({
  getAttachables: mocks.getAttachables,
  normalizeAttachables: mocks.normalizeAttachables,
}));
vi.mock('@/lib/qbo-attachment-workflow', () => ({ uploadFirstEvidenceItemToQbo: mocks.uploadFirstEvidenceItemToQbo }));

import { recordProcessedEvidence } from '@/lib/qbo-evidence-ingestion';
import type { ProcessedDocumentResult } from '@/lib/document-extraction';

function processedResult(
  matchResult: ProcessedDocumentResult['matchResult'],
  isDuplicate = false,
  duplicateOfDocumentId: string | null = null,
): ProcessedDocumentResult {
  return {
    matchResult,
    extractedFields: {
      vendorName: null, documentDate: null, totalAmount: null, documentNumber: null,
      documentType: null, rawText: '',
    },
    isDuplicate,
    duplicateOfDocumentId,
  };
}

function makeQuery(table: string) {
  const sequence = (mocks.calls.get(table) ?? 0) + 1;
  mocks.calls.set(table, sequence);
  const builder: Record<string, unknown> = { table, sequence, payload: null };
  for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder);
  builder.insert = vi.fn((payload: Record<string, unknown>) => { builder.payload = payload; return builder; });
  builder.maybeSingle = vi.fn(async () => {
    if (table === 'qbo_evidence_items' && sequence === 1) return { data: mocks.initialItem, error: null };
    if (table === 'inbox_documents') return { data: mocks.document, error: null };
    if (table === 'qbo_evidence_register') return { data: mocks.register, error: null };
    return { data: mocks.latestItem, error: null };
  });
  builder.single = vi.fn(async () => {
    mocks.inserted.push(builder.payload as Record<string, unknown>);
    return { data: { id: `item-${sequence}`, ...(builder.payload as Record<string, unknown>) }, error: null };
  });
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
    const data = table === 'qbo_evidence_items' && sequence === 2 ? mocks.existingItems : [];
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.clear();
  mocks.inserted.length = 0;
  mocks.initialItem = null;
  mocks.latestItem = null;
  mocks.existingItems = [];
  mocks.register = {
    id: 'register-1', realm_id: 'realm-1', qbo_txn_id: 'txn-1', qbo_txn_type: 'Invoice',
    register_state: 'MATCHED', matched_document_id: 'doc-1',
  };
  mocks.document = {
    id: 'doc-1', realm_id: 'realm-1', storage_path: 'inbox/realm-1/doc-1/receipt.pdf',
    filename: 'receipt.pdf', content_type: 'application/pdf', file_size: 4,
  };
  mocks.from.mockImplementation(makeQuery);
  mocks.storageDownload.mockResolvedValue({ data: new Blob(['%PDF']), error: null });
  mocks.getAttachables.mockResolvedValue({ attachables: [], httpStatus: 200 });
  mocks.normalizeAttachables.mockImplementation((items) => items);
  mocks.uploadFirstEvidenceItemToQbo.mockResolvedValue({ status: 'verified' });
});

describe('evidence item creation and first-evidence routing', () => {
  it('creates a primary item and invokes the guarded upload only for a unique confirmed match with no existing evidence', async () => {
    const result = await recordProcessedEvidence({
      realmId: 'realm-1', documentId: 'doc-1', actorUserId: 'user-1',
      result: processedResult({ documentId: 'doc-1', transactionId: 'txn-1', confidence: 95, matchSignals: { vendorMatch: false, amountMatch: false, dateMatch: false, documentNumberMatch: false }, status: 'matched' }),
    });

    expect(mocks.inserted[0]).toMatchObject({
      realm_id: 'realm-1', register_entry_id: 'register-1', inbox_document_id: 'doc-1',
      match_status: 'verified', review_status: 'not_required', evidence_role: 'primary',
      qbo_attachment_status: 'not_requested', content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.uploadFirstEvidenceItemToQbo).toHaveBeenCalledWith({ evidenceItemId: 'item-3', realmId: 'realm-1', actorUserId: 'user-1' });
    expect(result).toMatchObject({ evidenceRole: 'primary', qboAttachmentStatus: 'verified' });
  });

  it.each([['Invoice', 'Invoice'], ['Expense', 'Purchase'], ['Check', 'Purchase']])('recognizes existing %s evidence through canonical %s metadata', async (reportType, entityType) => {
    mocks.register!.qbo_txn_type = reportType;
    mocks.normalizeAttachables.mockReturnValue([{ entityId: 'txn-1', entityType }]);
    const result = await recordProcessedEvidence({
      realmId: 'realm-1', documentId: 'doc-1',
      result: processedResult({ documentId: 'doc-1', transactionId: 'txn-1', confidence: 95, matchSignals: { vendorMatch: false, amountMatch: false, dateMatch: false, documentNumberMatch: false }, status: 'matched' }),
    });
    expect(mocks.inserted[0]).toMatchObject({ match_status: 'verified', review_status: 'required', evidence_role: 'additional' });
    expect(mocks.uploadFirstEvidenceItemToQbo).not.toHaveBeenCalled();
    expect(result.evidenceRole).toBe('additional');
  });

  it('returns the actual review-required role after the final preflight downgrades a candidate primary', async () => {
    mocks.latestItem = { evidence_role: 'additional', qbo_attachment_status: 'not_requested' };
    mocks.uploadFirstEvidenceItemToQbo.mockRejectedValue(new Error('Additional evidence requires review'));
    const result = await recordProcessedEvidence({ realmId: 'realm-1', documentId: 'doc-1', result: processedResult({
      documentId: 'doc-1', transactionId: 'txn-1', confidence: 100, status: 'matched',
      matchSignals: { vendorMatch: true, amountMatch: true, dateMatch: true, documentNumberMatch: true },
    }) });
    expect(result).toMatchObject({ evidenceRole: 'additional', qboAttachmentStatus: 'not_requested' });
  });

  it('preserves an already matched transaction document and records a second certain document as additional review-required evidence', async () => {
    mocks.document = {
      id: 'doc-2', realm_id: 'realm-1', storage_path: 'inbox/realm-1/doc-2/second.pdf',
      filename: 'second.pdf', content_type: 'application/pdf', file_size: 4,
    };
    const result = await recordProcessedEvidence({
      realmId: 'realm-1', documentId: 'doc-2',
      result: processedResult({ documentId: 'doc-2', transactionId: 'txn-1', confidence: 95, matchSignals: { vendorMatch: false, amountMatch: false, dateMatch: false, documentNumberMatch: false }, status: 'matched' }),
    });

    expect(mocks.inserted[0]).toMatchObject({
      register_entry_id: 'register-1', inbox_document_id: 'doc-2',
      match_status: 'verified', review_status: 'required', evidence_role: 'additional',
      candidate_qbo_txn_ids: ['txn-1'],
    });
    expect(result.evidenceRole).toBe('additional');
    expect(mocks.getAttachables).not.toHaveBeenCalled();
    expect(mocks.uploadFirstEvidenceItemToQbo).not.toHaveBeenCalled();
  });

  it('stores uncertain candidates for review without calling the QuickBooks attachment APIs', async () => {
    const result = await recordProcessedEvidence({
      realmId: 'realm-1', documentId: 'doc-1',
      result: processedResult({
        documentId: 'doc-1', transactionId: null, confidence: 70,
        matchSignals: { vendorMatch: false, amountMatch: false, dateMatch: false, documentNumberMatch: false }, status: 'multiple_candidates',
        allCandidates: [
          { txnId: 'txn-1', txnType: null, date: null, vendor: null, amount: null, docNumber: null },
          { txnId: 'txn-2', txnType: null, date: null, vendor: null, amount: null, docNumber: null },
        ],
      }),
    });
    expect(mocks.inserted[0]).toMatchObject({ match_status: 'potential', review_status: 'required', evidence_role: 'unassigned', candidate_qbo_txn_ids: ['txn-1', 'txn-2'] });
    expect(mocks.getAttachables).not.toHaveBeenCalled();
    expect(mocks.uploadFirstEvidenceItemToQbo).not.toHaveBeenCalled();
    expect(result.evidenceRole).toBe('unassigned');
  });
});
