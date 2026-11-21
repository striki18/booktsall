import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  storageFrom: vi.fn(),
  storedDownload: vi.fn(),
  maybeSingle: vi.fn(),
  resolveQuery: vi.fn(),
  getAttachables: vi.fn(),
  getTransactionById: vi.fn(),
  normalizeAttachables: vi.fn(),
  downloadAttachableBytes: vi.fn(),
  uploadAttachable: vi.fn(),
  insertedEvents: [] as Array<Record<string, unknown>>,
  updatedTables: [] as string[],
  updateFilters: [] as Array<{ payload: Record<string, unknown>; column: string; expected: unknown }>,
}));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: mocks.from, storage: { from: mocks.storageFrom } },
}));
vi.mock('@/lib/quickbooks', () => ({
  downloadAttachableBytes: mocks.downloadAttachableBytes,
  getAttachables: mocks.getAttachables,
  getTransactionById: mocks.getTransactionById,
  normalizeAttachables: mocks.normalizeAttachables,
  uploadAttachable: mocks.uploadAttachable,
}));

import { reconcileQboAttachment, uploadFirstEvidenceItemToQbo } from '@/lib/qbo-attachment-workflow';

const realmId = '9341458707866620';
const evidenceItemId = '11111111-1111-4111-8111-111111111111';
const registerEntryId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const pdfBytes = Buffer.from('%PDF-1.7\nzevidt-test-evidence');

function builder(table: string) {
  let mode = 'select';
  let updatePayload: Record<string, unknown> = {};
  const value: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) value[method] = vi.fn(() => value);
  value.eq = vi.fn((column: string, expected: unknown) => {
    if (mode === 'update') mocks.updateFilters.push({ payload: updatePayload, column, expected });
    return value;
  });
  value.insert = vi.fn((payload: Record<string, unknown>) => {
    mode = 'insert';
    if (table === 'qbo_attachment_events') mocks.insertedEvents.push(payload);
    return value;
  });
  value.update = vi.fn((payload: Record<string, unknown>) => { mode = 'update'; updatePayload = payload; mocks.updatedTables.push(table); return value; });
  value.maybeSingle = vi.fn(() => mocks.maybeSingle(table, mode));
  value.single = value.maybeSingle;
  value.then = (resolve: (result: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(mocks.resolveQuery(table, mode)).then(resolve, reject);
  return value;
}

const primaryItem = {
  id: evidenceItemId, realm_id: realmId, register_entry_id: registerEntryId, source_type: 'client_upload',
  inbox_document_id: documentId, content_sha256: '', match_status: 'verified', review_status: 'not_required',
  evidence_role: 'primary', qbo_attachment_status: 'not_requested', qbo_attachable_id: null,
};
const register = {
  id: registerEntryId, realm_id: realmId, qbo_txn_id: '500', qbo_txn_type: 'Bill',
  register_state: 'MATCHED', matched_document_id: documentId,
};
const document = {
  id: documentId, realm_id: realmId, storage_path: 'inbox/realm/doc/file.pdf',
  filename: 'file.pdf', content_type: 'application/pdf', file_size: pdfBytes.length,
};
const contentSha256 = createHash('sha256').update(pdfBytes).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTUIT_REALM_ID = realmId;
  mocks.insertedEvents.length = 0;
  mocks.updatedTables.length = 0;
  mocks.updateFilters.length = 0;
  const item = { ...primaryItem, content_sha256: contentSha256 };
  const singleQueues = new Map<string, unknown[]>([
    ['qbo_evidence_items', [item, { id: evidenceItemId }]],
    ['qbo_evidence_register', [register]],
    ['inbox_documents', [document]],
  ]);
  mocks.maybeSingle.mockImplementation((table: string) => ({ data: singleQueues.get(table)?.shift() ?? null, error: null }));
  const awaitQueues = new Map<string, unknown[]>([
    ['qbo_evidence_items', [[{ id: evidenceItemId }], [{ id: evidenceItemId }]]],
  ]);
  mocks.resolveQuery.mockImplementation((table: string, mode: string) => {
    if (table === 'qbo_attachment_events' && mode === 'insert') return { data: null, error: null };
    if (table === 'qbo_evidence_items' && mode === 'select') return { data: awaitQueues.get(table)?.shift() ?? [], error: null };
    return { data: null, error: null };
  });
  mocks.from.mockImplementation((table: string) => builder(table));
  mocks.storageFrom.mockReturnValue({ download: mocks.storedDownload });
  mocks.storedDownload.mockResolvedValue({ data: new Blob([pdfBytes]), error: null });
  mocks.getTransactionById.mockResolvedValue({ transaction: { Id: '500' }, httpStatus: 200 });
  mocks.getAttachables
    .mockResolvedValueOnce({ attachables: [], httpStatus: 200 })
    .mockResolvedValueOnce({ attachables: [], httpStatus: 200 })
    .mockResolvedValueOnce({ attachables: [{ attachableId: '9001', entityId: '500', entityType: 'Bill' }], httpStatus: 200 });
  mocks.normalizeAttachables.mockImplementation((raw: unknown) => Array.isArray(raw) ? raw : []);
  mocks.uploadAttachable.mockResolvedValue({ attachable: { Id: '9001' }, httpStatus: 200 });
});

describe('QBO attachment workflow completion', () => {
  it('keeps the unique primary winner when a concurrent additional document is still awaiting review', async () => {
    mocks.resolveQuery.mockImplementation((table: string, mode: string) => ({
      data: table === 'qbo_evidence_items' && mode === 'select' ? [
        { id: evidenceItemId, evidence_role: 'primary', review_status: 'not_required', qbo_attachment_status: 'pending' },
        { id: 'concurrent-additional', evidence_role: 'additional', review_status: 'required', qbo_attachment_status: 'not_requested' },
      ] : null, error: null,
    }));
    await expect(uploadFirstEvidenceItemToQbo({ realmId, evidenceItemId, actorUserId: null })).resolves.toMatchObject({ status: 'verified' });
    expect(mocks.uploadAttachable).toHaveBeenCalledOnce();
    expect(mocks.updateFilters.some(filter => filter.payload.evidence_role === 'additional')).toBe(false);
  });
  it('blocks a known exact copy on another QBO transaction before creating an upload attempt', async () => {
    const approved = { ...primaryItem, content_sha256: contentSha256, evidence_role: 'additional', review_status: 'approved' };
    const queues = new Map<string, unknown[]>([
      ['qbo_evidence_items', [approved]],
      ['qbo_evidence_register', [register]],
      ['qbo_evidence_item_review_events', [{ id: 'approval', action: 'approve_additional', selected_register_entry_id: registerEntryId }]],
      ['inbox_documents', [document]],
    ]);
    mocks.maybeSingle.mockImplementation((table: string) => ({ data: queues.get(table)?.shift() ?? null, error: null }));
    mocks.resolveQuery.mockImplementation((table: string) => ({ data: table === 'qbo_evidence_items' ? [{ qbo_attachable_id: '9001' }] : null, error: null }));
    mocks.getAttachables.mockReset().mockResolvedValue({ attachables: [{ attachableId: '9001', entityId: 'other-transaction', entityType: 'Bill' }], httpStatus: 200 });
    await expect(uploadFirstEvidenceItemToQbo({ realmId, evidenceItemId, actorUserId: 'reviewer' })).rejects.toMatchObject({ status: 409 });
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
    expect(mocks.insertedEvents.map(event => event.event_type)).toEqual(['preflight_blocked']);
  });
  it.each(['verified', 'wrong-bytes', 'wrong-transaction'])('reconciles unknown outcomes safely: %s', async (scenario) => {
    const queues = new Map<string, unknown[]>([
      ['qbo_evidence_items', [{ ...primaryItem, content_sha256: contentSha256, qbo_attachment_status: 'unknown' }, { id: evidenceItemId }]],
      ['qbo_attachment_events', [{ attempt_id: 'original-attempt', qbo_txn_id: '500', qbo_txn_type: 'Bill' }]],
      ['qbo_evidence_register', [register]],
    ]);
    mocks.maybeSingle.mockImplementation((table: string) => ({ data: queues.get(table)?.shift() ?? null, error: null }));
    mocks.getAttachables.mockReset().mockResolvedValue({ attachables: [{ attachableId: '9001', entityId: scenario === 'wrong-transaction' ? 'other' : '500', entityType: 'Bill' }], httpStatus: 200 });
    mocks.downloadAttachableBytes.mockResolvedValue({ bytes: scenario === 'wrong-bytes' ? Buffer.from('other') : pdfBytes, httpStatus: 200 });
    const result = reconcileQboAttachment({ realmId, evidenceItemId, attachableId: '9001', actorUserId: null });
    if (scenario === 'verified') {
      await expect(result).resolves.toMatchObject({ status: 'verified', qboAttachableId: '9001' });
      expect(mocks.insertedEvents).toEqual([expect.objectContaining({ event_type: 'verification_succeeded', attempt_id: 'original-attempt', details: expect.objectContaining({ content_sha256_verified: true }) })]);
    } else {
      await expect(result).rejects.toMatchObject({ status: 409 });
      expect(mocks.insertedEvents).toHaveLength(0);
      expect(mocks.updatedTables).toHaveLength(0);
    }
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
  });

  it('blocks upload if concurrent state changes prevent moving the pending item to review', async () => {
    const single = mocks.maybeSingle.getMockImplementation()!;
    let updates = 0;
    mocks.maybeSingle.mockImplementation((table: string, mode: string) => {
      if (mode === 'update') return { data: ++updates === 1 ? { id: evidenceItemId } : null, error: null };
      return single(table, mode);
    });
    mocks.getAttachables.mockReset()
      .mockResolvedValueOnce({ attachables: [], httpStatus: 200 })
      .mockResolvedValueOnce({ attachables: [{ attachableId: 'new-evidence', entityId: '500', entityType: 'Bill' }], httpStatus: 200 });

    await expect(uploadFirstEvidenceItemToQbo({ evidenceItemId, realmId, actorUserId: 'reviewer-1' }))
      .rejects.toBeInstanceOf(Error);
    expect(updates).toBeGreaterThanOrEqual(2);
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
    expect(mocks.insertedEvents.some(event => event.event_type === 'preflight_blocked')).toBe(true);
  });
  it('moves pending first evidence to additional review when QBO evidence appears at final preflight', async () => {
    const single = mocks.maybeSingle.getMockImplementation()!;
    mocks.maybeSingle.mockImplementation((table: string, mode: string) => mode === 'update'
      ? { data: { id: evidenceItemId }, error: null }
      : single(table, mode));
    mocks.getAttachables.mockReset()
      .mockResolvedValueOnce({ attachables: [], httpStatus: 200 })
      .mockResolvedValueOnce({ attachables: [{ attachableId: 'new-evidence', entityId: '500', entityType: 'Bill' }], httpStatus: 200 });

    await expect(uploadFirstEvidenceItemToQbo({ evidenceItemId, realmId, actorUserId: 'reviewer-1' }))
      .rejects.toMatchObject({ status: 409 });

    expect(mocks.updateFilters).toContainEqual({
      payload: { evidence_role: 'additional', review_status: 'required' },
      column: 'qbo_attachment_status', expected: 'pending',
    });
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
    expect(mocks.insertedEvents.map(event => event.event_type)).toEqual(['attempt_started', 'preflight_blocked']);
  });
  it('uploads first verified evidence once and verifies its transaction association by read-back', async () => {
    const result = await uploadFirstEvidenceItemToQbo({ evidenceItemId, realmId, actorUserId: 'reviewer-1' });

    expect(result).toMatchObject({ evidenceItemId, qboTxnId: '500', qboAttachableId: '9001', status: 'verified' });
    expect(mocks.uploadAttachable).toHaveBeenCalledOnce();
    expect(mocks.uploadAttachable).toHaveBeenCalledWith(pdfBytes, 'file.pdf', 'application/pdf', 'Bill', '500', realmId);
    expect(mocks.insertedEvents.map((event) => event.event_type)).toEqual([
      'attempt_started', 'upload_succeeded', 'verification_succeeded',
    ]);
    expect(mocks.getAttachables).toHaveBeenCalledTimes(3);
    expect(mocks.updatedTables).not.toContain('qbo_evidence_register');
  });

  it('allows a human-confirmed candidate match when the original transaction row was missing evidence', async () => {
    const confirmedPrimary = { ...primaryItem, content_sha256: contentSha256 };
    const missingRegister = { ...register, register_state: 'MISSING', matched_document_id: null };
    const singleQueues = new Map<string, unknown[]>([
      ['qbo_evidence_items', [confirmedPrimary, { id: evidenceItemId }]],
      ['qbo_evidence_item_review_events', [{ id: 'confirm-event', action: 'confirm_match', selected_register_entry_id: registerEntryId }]],
      ['qbo_evidence_register', [missingRegister]],
      ['inbox_documents', [document]],
    ]);
    mocks.maybeSingle.mockImplementation((table: string) => ({ data: singleQueues.get(table)?.shift() ?? null, error: null }));

    const result = await uploadFirstEvidenceItemToQbo({ evidenceItemId, realmId, actorUserId: 'reviewer-1' });

    expect(result).toMatchObject({ qboTxnId: '500', status: 'verified' });
    expect(mocks.uploadAttachable).toHaveBeenCalledOnce();
    expect(mocks.updatedTables).not.toContain('qbo_evidence_register');
  });

  it('links identical existing QBO bytes without uploading a second copy', async () => {
    const approvedAdditional = {
      ...primaryItem, content_sha256: contentSha256, review_status: 'approved', evidence_role: 'additional',
    };
    const singleQueues = new Map<string, unknown[]>([
      ['qbo_evidence_items', [approvedAdditional, { id: 'existing-zevidt-item' }, { id: evidenceItemId }]],
      ['qbo_evidence_item_review_events', [{ id: 'approval-event' }]],
      ['qbo_evidence_register', [register]],
      ['inbox_documents', [document]],
    ]);
    mocks.maybeSingle.mockImplementation((table: string) => ({ data: singleQueues.get(table)?.shift() ?? null, error: null }));
    mocks.getAttachables.mockReset().mockResolvedValue({
      attachables: [{ attachableId: '9001', entityId: '500', entityType: 'Bill' }], httpStatus: 200,
    });
    mocks.downloadAttachableBytes.mockResolvedValue({ bytes: pdfBytes, httpStatus: 200 });
    mocks.resolveQuery.mockImplementation((table: string) => {
      if (table === 'qbo_evidence_items') return { data: [{ id: evidenceItemId }], error: null };
      if (table === 'qbo_attachment_events') return { data: null, error: null };
      return { data: null, error: null };
    });

    const result = await uploadFirstEvidenceItemToQbo({ evidenceItemId, realmId, actorUserId: 'reviewer-1' });

    expect(result).toMatchObject({ qboAttachableId: '9001', status: 'verified', duplicate: true });
    expect(mocks.downloadAttachableBytes).toHaveBeenCalledOnce();
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
    expect(mocks.insertedEvents.map((event) => event.event_type)).toEqual(['preflight_blocked']);
  });
});
