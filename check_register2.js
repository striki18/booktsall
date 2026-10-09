import { supabaseAdmin } from './lib/supabase-admin';
const { data, error } = await supabaseAdmin.from('qbo_evidence_register').select('*').eq('realm_id', 'sandbox_company');
if (error) { console.error(error); process.exit(1); }
console.log('Total:', data.length);
const states = {};
data.forEach(d => { states[d.register_state] = (states[d.register_state] || 0) + 1; });
console.log('States:', states);