import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn(), upload: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock('@/lib/qbo-attachment-workflow', () => ({
  QboAttachmentWorkflowError: class QboAttachmentWorkflowError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  uploadFirstEvidenceItemToQbo: mocks.upload,
}));

import { POST } from '@/app/api/evidence/items/[id]/review/route';

const itemId = '11111111-1111-4111-8111-111111111111';
const registerId = '22222222-2222-4222-8222-222222222222';
const context = { params: Promise.resolve({ id: itemId }) };

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/evidence/items/' + itemId + '/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'reviewer-1' }, realmId: '9341458707866620' });
  mocks.rpc.mockResolvedValue({ data: { id: itemId, review_status: 'approved' }, error: null });
  mocks.upload.mockResolvedValue({ status: 'verified', qboAttachableId: '55' });
});

describe('evidence-item review API', () => {
  it('requires an explicit final confirmation before recording a decision', async () => {
    const response = await POST(request({ action: 'approve_additional' }), context);
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('records an approved additional decision in the authenticated realm and attaches afterward', async () => {
    const response = await POST(request({ action: 'approve_additional', finalConfirmation: true, rationale: 'Reviewed' }), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('record_qbo_evidence_item_review', {
      p_realm_id: '9341458707866620',
      p_evidence_item_id: itemId,
      p_reviewer_user_id: 'reviewer-1',
      p_action: 'approve_additional',
      p_selected_register_entry_id: null,
      p_rationale: 'Reviewed',
    });
    expect(mocks.upload).toHaveBeenCalledWith({ evidenceItemId: itemId, realmId: '9341458707866620', actorUserId: 'reviewer-1' });
    expect(body.decisionRecorded).toBe(true);
    expect(body.attachment.status).toBe('verified');
  });

  it('requires a transaction for Duplicate Add and preserves Discard without QBO upload', async () => {
    const invalid = await POST(request({ action: 'add_duplicate', finalConfirmation: true }), context);
    expect(invalid.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();

    const discarded = await POST(request({ action: 'discard_duplicate', finalConfirmation: true }), context);
    expect(discarded.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('requires a valid same-company register selection for Duplicate Add', async () => {
    const response = await POST(request({ action: 'add_duplicate', registerEntryId: registerId, finalConfirmation: true }), context);
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('record_qbo_evidence_item_review', expect.objectContaining({
      p_realm_id: '9341458707866620',
      p_action: 'add_duplicate',
      p_selected_register_entry_id: registerId,
    }));
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it('requires a selected candidate before confirming a potential match', async () => {
    const response = await POST(request({ action: 'confirm_match', finalConfirmation: true }), context);
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('attaches a confirmed first match but leaves it for additional approval when the transaction already has evidence', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { id: itemId, evidence_role: 'primary', review_status: 'not_required' }, error: null });
    const primaryResponse = await POST(request({ action: 'confirm_match', registerEntryId: registerId, finalConfirmation: true }), context);
    expect(primaryResponse.status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith('record_qbo_evidence_item_review', expect.objectContaining({
      p_action: 'confirm_match', p_selected_register_entry_id: registerId, p_realm_id: '9341458707866620',
    }));

    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user: { id: 'reviewer-1' }, realmId: '9341458707866620' });
    mocks.rpc.mockResolvedValueOnce({ data: { id: itemId, evidence_role: 'additional', review_status: 'required' }, error: null });
    const additionalResponse = await POST(request({ action: 'confirm_match', registerEntryId: registerId, finalConfirmation: true }), context);
    const body = await additionalResponse.json();
    expect(additionalResponse.status).toBe(200);
    expect(body.requiresAdditionalApproval).toBe(true);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
