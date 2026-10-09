import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('qbo_evidence_register')
    .select('*')
    .eq('realm_id', '9341457539527702');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const states: Record<string, number> = {};
  data.forEach(d => { states[d.register_state] = (states[d.register_state] || 0) + 1; });

  const txn145 = data.find(d => d.qbo_txn_id === '145' || d.qbo_txn_id === 145);

  return NextResponse.json({
    totalRows: data.length,
    states,
    transaction145: txn145 || null,
    allRows: data.map(d => ({
      qbo_txn_id: d.qbo_txn_id,
      qbo_txn_date: d.qbo_txn_date,
      register_state: d.register_state,
    })),
  });
}