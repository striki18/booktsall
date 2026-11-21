import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  uploadFirstEvidenceItemToQbo: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/qbo-attachment-workflow', () => ({
  QboAttachmentWorkflowError: class QboAttachmentWorkflowError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  uploadFirstEvidenceItemToQbo: mocks.uploadFirstEvidenceItemToQbo,
}));

import { POST } from '@/app/api/quickbooks/attachables/upload/route';

function request(body: unknown) {
  return new Request('http://localhost/api/quickbooks/attachables/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1' }, realmId: 'sandbox-1' });
  mocks.uploadFirstEvidenceItemToQbo.mockResolvedValue({
    evidenceItemId: '0c88e4e3-4b80-4e07-a36a-59a89fbc1ac8',
    qboTxnId: 'txn-1',
    qboAttachableId: 'attachable-1',
    status: 'verified',
  });
});

describe('QuickBooks attachment upload endpoint', () => {
  it('rejects unauthenticated callers before invoking the upload workflow', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await POST(request({ evidenceItemId: '0c88e4e3-4b80-4e07-a36a-59a89fbc1ac8' }));
    expect(response.status).toBe(401);
    expect(mocks.uploadFirstEvidenceItemToQbo).not.toHaveBeenCalled();
  });

  it('requires a valid evidence item id', async () => {
    const response = await POST(request({ evidenceItemId: 'transaction-1' }));
    expect(response.status).toBe(400);
    expect(mocks.uploadFirstEvidenceItemToQbo).not.toHaveBeenCalled();
  });

  it('uses only the authenticated user and realm and returns the verified outcome', async () => {
    const evidenceItemId = '0c88e4e3-4b80-4e07-a36a-59a89fbc1ac8';
    const response = await POST(request({ evidenceItemId, realmId: 'attacker-realm' }));
    expect(response.status).toBe(200);
    expect(mocks.uploadFirstEvidenceItemToQbo).toHaveBeenCalledWith({ evidenceItemId, realmId: 'sandbox-1', actorUserId: 'user-1' });
    expect(await response.json()).toMatchObject({ status: 'verified', qboTxnId: 'txn-1' });
  });

  it('preserves fail-closed workflow status without exposing credentials', async () => {
    const { QboAttachmentWorkflowError } = await import('@/lib/qbo-attachment-workflow');
    mocks.uploadFirstEvidenceItemToQbo.mockRejectedValue(new QboAttachmentWorkflowError('An attachment attempt already exists; reconcile it before retrying', 409));
    const response = await POST(request({ evidenceItemId: '0c88e4e3-4b80-4e07-a36a-59a89fbc1ac8' }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('reconcile');
  });
});
