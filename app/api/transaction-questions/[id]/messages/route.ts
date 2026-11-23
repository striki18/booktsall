import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { realmId, user } = await requireAuth();
    const { id } = await params;
    const payload = await request.json().catch(() => null) as null | { body?: unknown };
    const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
    if (!body || body.length > 4000) return NextResponse.json({ error: 'Reply must contain 1 to 4000 characters' }, { status: 400 });
    const { data: question } = await supabaseAdmin.from('transaction_questions').select('id,audience,status').eq('realm_id', realmId).eq('id', id).single();
    if (!question || question.status === 'resolved') return NextResponse.json({ error: 'Open question not found' }, { status: 404 });
    const authorRole = question.audience === 'accountant' ? 'accountant' : 'firm';
    const { data: messageId, error } = await supabaseAdmin.rpc('answer_transaction_question', {
      p_realm_id: realmId, p_question_id: id, p_body: body, p_actor_role: authorRole, p_actor_user_id: user.id,
    });
    if (error || !messageId) return NextResponse.json({ error: 'Unable to save reply' }, { status: 503 });
    return NextResponse.json({ id: messageId, question_id: id, author_role: authorRole, body }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ error: message === 'UNAUTHORIZED' ? 'Authentication required' : 'Unable to save reply' }, { status: message === 'UNAUTHORIZED' ? 401 : 500 });
  }
}
