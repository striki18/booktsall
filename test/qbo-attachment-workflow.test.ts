import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getAttachables: vi.fn(),
  getTransactionById: vi.fn(),
  normalizeAttachables: vi.fn(),
  uploadAttachable: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: mocks.from, storage: { from: vi.fn() } },
}));
vi.mock('@/lib/quickbooks', () => ({
  getAttachables: mocks.getAttachables,
  getTransactionById: mocks.getTransactionById,
  normalizeAttachables: mocks.normalizeAttachables,
  uploadAttachable: mocks.uploadAttachable,
}));

import { uploadFirstEvidenceItemToQbo } from '@/lib/qbo-attachment-workflow';

function query() {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'update', 'insert']) builder[method] = vi.fn(() => builder);
  builder.maybeSingle = mocks.maybeSingle;
  builder.single = mocks.maybeSingle;
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTUIT_REALM_ID = '9341458707866620';
  mocks.from.mockImplementation(() => query());
  mocks.normalizeAttachables.mockReturnValue([]);
});

describe('first-evidence QuickBooks attachment guard', () => {
  it('rejects a realm that differs from the configured sandbox before database or QBO access', async () => {
    await expect(uploadFirstEvidenceItemToQbo({ evidenceItemId: 'item-1', realmId: '9341458707866621', actorUserId: 'user-1' }))
      .rejects.toMatchObject({ status: 403 });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getAttachables).not.toHaveBeenCalled();
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
  });

  it('rejects additional or review-required evidence before transaction lookup or upload', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: {
      id: 'item-1', realm_id: '9341458707866620', source_type: 'client_upload',
      register_entry_id: 'register-1', inbox_document_id: 'doc-1',
      match_status: 'verified', review_status: 'required', evidence_role: 'additional',
      qbo_attachment_status: 'not_requested', qbo_attachable_id: null,
    }, error: null });
    await expect(uploadFirstEvidenceItemToQbo({ evidenceItemId: 'item-1', realmId: '9341458707866620', actorUserId: 'user-1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.getTransactionById).not.toHaveBeenCalled();
    expect(mocks.getAttachables).not.toHaveBeenCalled();
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
  });

  it('rejects a pending or previously attempted item without another upload', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: {
      id: 'item-1', realm_id: '9341458707866620', source_type: 'client_upload',
      register_entry_id: 'register-1', inbox_document_id: 'doc-1',
      match_status: 'verified', review_status: 'not_required', evidence_role: 'primary',
      qbo_attachment_status: 'pending', qbo_attachable_id: null,
    }, error: null });
    await expect(uploadFirstEvidenceItemToQbo({ evidenceItemId: 'item-1', realmId: '9341458707866620', actorUserId: 'user-1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.getTransactionById).not.toHaveBeenCalled();
    expect(mocks.uploadAttachable).not.toHaveBeenCalled();
  });
});
