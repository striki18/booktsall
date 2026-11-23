import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

async function publicInboxRealm(token: string) {
  const { data } = await supabaseAdmin.from('company_inboxes').select('realm_id').eq('token', token).single();
  return data?.realm_id as string | undefined;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const realmId = await publicInboxRealm(token);
  if (!realmId) return NextResponse.json({ error: 'Invalid inbox link' }, { status: 404 });
  const { data: questions, error } = await supabaseAdmin.from('transaction_questions')
    .select('id,qbo_txn_type,qbo_txn_date,qbo_txn_vendor,qbo_txn_amount,qbo_txn_doc_number,status,created_at')
    .eq('realm_id', realmId).eq('audience', 'client').neq('status', 'resolved').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Unable to load questions' }, { status: 503 });
  const ids = (questions ?? []).map((question) => question.id);
  const { data: messages, error: messagesError } = ids.length
    ? await supabaseAdmin.from('transaction_question_messages').select('id,question_id,author_role,body,created_at').eq('realm_id', realmId).in('question_id', ids).order('created_at')
    : { data: [], error: null };
  if (messagesError) return NextResponse.json({ error: 'Unable to load question messages' }, { status: 503 });
  return NextResponse.json((questions ?? []).map((question) => ({ ...question, messages: (messages ?? []).filter((message) => message.question_id === question.id) })));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const realmId = await publicInboxRealm(token);
  if (!realmId) return NextResponse.json({ error: 'Invalid inbox link' }, { status: 404 });
  const payload = await request.json().catch(() => null) as null | { questionId?: unknown; body?: unknown };
  const questionId = typeof payload?.questionId === 'string' ? payload.questionId : '';
  const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
  if (!questionId || !body || body.length > 4000) return NextResponse.json({ error: 'Question and reply of up to 4000 characters are required' }, { status: 400 });
  const { data: question } = await supabaseAdmin.from('transaction_questions').select('id,status').eq('realm_id', realmId).eq('id', questionId).eq('audience', 'client').single();
  if (!question || question.status === 'resolved') return NextResponse.json({ error: 'Open question not found' }, { status: 404 });
  const { data: messageId, error } = await supabaseAdmin.rpc('answer_transaction_question', {
    p_realm_id: realmId, p_question_id: questionId, p_body: body, p_actor_role: 'client', p_actor_user_id: null,
  });
  if (error || !messageId) return NextResponse.json({ error: 'Unable to save reply' }, { status: 503 });
  return NextResponse.json({ id: messageId, question_id: questionId, author_role: 'client', body }, { status: 201 });
}
