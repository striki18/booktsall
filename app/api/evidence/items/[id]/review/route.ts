import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { QboAttachmentWorkflowError, uploadFirstEvidenceItemToQbo } from '@/lib/qbo-attachment-workflow';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['confirm_match', 'approve_additional', 'add_duplicate', 'discard_additional', 'discard_duplicate']);

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  let auth: { user: { id: string }; realmId: string };
  try {
    auth = await requireAuth();
  } catch (error) {
    const status = error instanceof Error && error.message === 'UNAUTHORIZED' ? 401 : 403;
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'No authorized QuickBooks company is connected' }, { status });
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid evidence item ID' }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid review decision' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const action = payload.action;
  const registerEntryId = payload.registerEntryId;
  const rationale = payload.rationale;
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    return NextResponse.json({ error: 'Unsupported evidence review action' }, { status: 400 });
  }
  if (payload.finalConfirmation !== true) {
    return NextResponse.json({ error: 'Confirm this evidence decision before continuing' }, { status: 400 });
  }
  if ((action === 'add_duplicate' || action === 'confirm_match') && (typeof registerEntryId !== 'string' || !UUID_PATTERN.test(registerEntryId))) {
    return NextResponse.json({ error: action === 'confirm_match' ? 'Choose a candidate QuickBooks transaction' : 'Choose the QuickBooks transaction for this duplicate' }, { status: 400 });
  }
  if (registerEntryId !== undefined && (typeof registerEntryId !== 'string' || !UUID_PATTERN.test(registerEntryId))) {
    return NextResponse.json({ error: 'Invalid register entry ID' }, { status: 400 });
  }
  if (rationale !== undefined && (typeof rationale !== 'string' || rationale.length > 2000)) {
    return NextResponse.json({ error: 'Invalid review note' }, { status: 400 });
  }

  const { data: item, error } = await supabaseAdmin.rpc('record_qbo_evidence_item_review', {
    p_realm_id: auth.realmId,
    p_evidence_item_id: id,
    p_reviewer_user_id: auth.user.id,
    p_action: action,
    p_selected_register_entry_id: typeof registerEntryId === 'string' ? registerEntryId : null,
    p_rationale: typeof rationale === 'string' ? rationale : null,
  });
  if (error || !item) {
    return NextResponse.json({ error: 'The evidence item could not be reviewed or is no longer awaiting a decision' }, { status: 409 });
  }

  if (action === 'discard_duplicate' || action === 'discard_additional') {
    return NextResponse.json({ decisionRecorded: true, item, attachment: null }, { status: 200 });
  }
  if (action === 'confirm_match' && item.evidence_role !== 'primary') {
    return NextResponse.json({
      decisionRecorded: true,
      item,
      attachment: null,
      requiresAdditionalApproval: true,
    }, { status: 200 });
  }

  try {
    const attachment = await uploadFirstEvidenceItemToQbo({
      evidenceItemId: id,
      realmId: auth.realmId,
      actorUserId: auth.user.id,
    });
    return NextResponse.json({ decisionRecorded: true, item, attachment }, { status: 200 });
  } catch (cause) {
    if (cause instanceof QboAttachmentWorkflowError) {
      return NextResponse.json({ decisionRecorded: true, item, error: cause.message }, { status: cause.status });
    }
    console.error('Approved evidence attachment failed');
    return NextResponse.json({ decisionRecorded: true, item, error: 'Approved evidence could not be attached' }, { status: 500 });
  }
}
