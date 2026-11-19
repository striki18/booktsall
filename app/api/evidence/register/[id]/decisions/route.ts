import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/auth';
import { ownershipErrorStatus } from '@/lib/resource-access';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = new Set(['confirm_match', 'reject_match', 'mark_wrong_match', 'assign_transaction']);

type RouteContext = { params: Promise<{ id: string }> };

function authFailure(error: unknown) {
  const status = ownershipErrorStatus(error);
  if (!status) return null;
  return NextResponse.json(
    { error: status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : 'Ownership check failed' },
    { status },
  );
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    return authFailure(error) ?? NextResponse.json({ error: 'Unable to authenticate' }, { status: 500 });
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid register entry ID' }, { status: 400 });

  const { data: registerEntry, error: registerError } = await context.supabase
    .from('qbo_evidence_register')
    .select('id, matched_document_id')
    .eq('realm_id', context.realmId)
    .eq('id', id)
    .maybeSingle();
  if (registerError) return NextResponse.json({ error: 'Unable to verify register entry' }, { status: 500 });
  if (!registerEntry) return NextResponse.json({ error: 'Register entry not found' }, { status: 404 });

  const queries = [context.supabase
    .from('evidence_review_decisions')
    .select('*')
    .eq('realm_id', context.realmId)
    .eq('register_entry_id', id)
    .order('created_at', { ascending: true })];
  if (registerEntry.matched_document_id) {
    queries.push(context.supabase
      .from('evidence_review_decisions')
      .select('*')
      .eq('realm_id', context.realmId)
      .eq('evidence_document_id', registerEntry.matched_document_id)
      .order('created_at', { ascending: true }));
  }

  const results = await Promise.all(queries);
  if (results.some(result => result.error)) return NextResponse.json({ error: 'Unable to load review history' }, { status: 500 });
  const unique = new Map<string, Record<string, unknown>>();
  for (const result of results) for (const decision of result.data ?? []) unique.set(decision.id, decision);
  const decisions = [...unique.values()].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  return NextResponse.json({ decisions });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    return authFailure(error) ?? NextResponse.json({ error: 'Unable to authenticate' }, { status: 500 });
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid register entry ID' }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid decision' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const action = payload.action;
  const selectedQboTxnId = payload.selectedQboTxnId;
  const rationale = payload.rationale;
  if (typeof action !== 'string' || !DECISIONS.has(action)) {
    return NextResponse.json({ error: 'Unsupported decision action' }, { status: 400 });
  }
  if (selectedQboTxnId !== undefined && (typeof selectedQboTxnId !== 'string' || selectedQboTxnId.length > 128)) {
    return NextResponse.json({ error: 'Invalid selected transaction ID' }, { status: 400 });
  }
  if ((action === 'assign_transaction' || action === 'mark_wrong_match') && !selectedQboTxnId) {
    return NextResponse.json({ error: 'A transaction ID is required for this decision' }, { status: 400 });
  }
  if (rationale !== undefined && (typeof rationale !== 'string' || rationale.length > 2000)) {
    return NextResponse.json({ error: 'Invalid rationale' }, { status: 400 });
  }

  const { data: registerEntry, error: registerError } = await context.supabase
    .from('qbo_evidence_register')
    .select('id, matched_document_id, qbo_txn_id')
    .eq('id', id)
    .eq('realm_id', context.realmId)
    .maybeSingle();
  if (registerError) return NextResponse.json({ error: 'Unable to verify register entry' }, { status: 500 });
  if (!registerEntry) return NextResponse.json({ error: 'Register entry not found' }, { status: 404 });
  const decisionTxnId = selectedQboTxnId ?? (action === 'confirm_match' ? registerEntry.qbo_txn_id : null);
  if ((action === 'confirm_match' || action === 'assign_transaction') && !decisionTxnId) {
    return NextResponse.json({ error: 'A transaction ID is required to confirm a match' }, { status: 400 });
  }

  const { data, error } = await context.supabase
    .from('evidence_review_decisions')
    .insert({
      realm_id: context.realmId,
      register_entry_id: id,
      evidence_document_id: registerEntry.matched_document_id ?? null,
      reviewer_user_id: context.user.id,
      action,
      selected_qbo_txn_id: decisionTxnId,
      rationale: rationale ?? null,
    })
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: 'Unable to save review decision' }, { status: 500 });
  return NextResponse.json({ decision: data }, { status: 201 });
}
