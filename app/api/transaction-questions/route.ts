import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

function authError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (message === 'NO_REALM_ID' || message === 'FORBIDDEN') return NextResponse.json({ error: 'No authorized company is connected' }, { status: 403 });
  return null;
}

export async function GET() {
  try {
    const { realmId } = await requireAuth();
    const { data: questions, error } = await supabaseAdmin
      .from('transaction_questions')
      .select('*')
      .eq('realm_id', realmId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return NextResponse.json({ error: 'Unable to load transaction questions' }, { status: 503 });
    const questionIds = (questions ?? []).map((question) => question.id);
    const { data: messages, error: messagesError } = questionIds.length
      ? await supabaseAdmin.from('transaction_question_messages').select('*').eq('realm_id', realmId).in('question_id', questionIds).order('created_at')
      : { data: [], error: null };
    if (messagesError) return NextResponse.json({ error: 'Unable to load question replies' }, { status: 503 });
    return NextResponse.json((questions ?? []).map((question) => ({
      ...question,
      messages: (messages ?? []).filter((message) => message.question_id === question.id),
    })));
  } catch (error) {
    return authError(error) ?? NextResponse.json({ error: 'Unable to load transaction questions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { realmId, user } = await requireAuth();
    const body = await request.json().catch(() => null) as null | Record<string, unknown>;
    const qboTxnId = typeof body?.qboTxnId === 'string' ? body.qboTxnId.trim() : '';
    const audience = body?.audience === 'client' || body?.audience === 'accountant' ? body.audience : null;
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!qboTxnId || !audience || !question || question.length > 4000) {
      return NextResponse.json({ error: 'Transaction, recipient, and a question of up to 4000 characters are required' }, { status: 400 });
    }

    const { data: createdId, error } = await supabaseAdmin.rpc('create_transaction_question', {
      p_realm_id: realmId, p_qbo_txn_id: qboTxnId,
      p_qbo_txn_type: typeof body?.qboTxnType === 'string' ? body.qboTxnType : null,
      p_qbo_txn_date: typeof body?.qboTxnDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.qboTxnDate) ? body.qboTxnDate : null,
      p_qbo_txn_vendor: typeof body?.qboTxnVendor === 'string' ? body.qboTxnVendor : null,
      p_qbo_txn_amount: typeof body?.qboTxnAmount === 'number' && Number.isFinite(body.qboTxnAmount) ? body.qboTxnAmount : null,
      p_qbo_txn_doc_number: typeof body?.qboTxnDocNumber === 'string' ? body.qboTxnDocNumber : null,
      p_audience: audience, p_body: question, p_actor_user_id: user.id,
    });
    if (error || !createdId) return NextResponse.json({ error: 'Unable to create transaction question' }, { status: 503 });
    const { data: created } = await supabaseAdmin.from('transaction_questions').select('*').eq('realm_id', realmId).eq('id', createdId).single();
    if (!created) return NextResponse.json({ error: 'Question was created but could not be reloaded' }, { status: 503 });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return authError(error) ?? NextResponse.json({ error: 'Unable to create transaction question' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { realmId, user } = await requireAuth();
    const body = await request.json().catch(() => null) as null | Record<string, unknown>;
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id || body?.action !== 'resolve') return NextResponse.json({ error: 'Question and resolve action are required' }, { status: 400 });
    const { data: resolved, error } = await supabaseAdmin.rpc('resolve_transaction_question', { p_realm_id: realmId, p_question_id: id, p_actor_user_id: user.id });
    if (error || !resolved) return NextResponse.json({ error: 'Question was not found or is already resolved' }, { status: 409 });
    return NextResponse.json({ id, status: 'resolved' });
  } catch (error) {
    return authError(error) ?? NextResponse.json({ error: 'Unable to resolve transaction question' }, { status: 500 });
  }
}
