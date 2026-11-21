import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireAuth } from '@/lib/auth';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Use direct REST API calls with fetch to avoid Supabase client hanging issues
async function supabaseQuery(table: string, options: {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  select?: string;
  filter?: Record<string, string>;
  body?: unknown;
  single?: boolean;
  order?: { column: string; ascending: boolean };
  limit?: number;
  isNull?: string[];
}) {
  const { method = 'GET', select = '*', filter = {}, body, single = false, order, limit, isNull = [] } = options;
  
  let url = `${supabaseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
  
  // Add filters
  for (const [key, value] of Object.entries(filter)) {
    url += `&${key}=eq.${encodeURIComponent(value)}`;
  }

  for (const column of isNull) {
    url += `&${column}=is.null`;
  }
  
  // Add order
  if (order) {
    url += `&order=${order.column}.${order.ascending ? 'asc' : 'desc'}`;
  }
  
  // Add limit
  if (limit) {
    url += `&limit=${limit}`;
  }
  
  // Add single
  if (single) {
    url += '&limit=1';
  }

  const response = await fetch(url, {
    method,
    headers: {
      'apikey': supabaseServiceKey,
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
      'Prefer': single ? 'return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
    // Add timeout
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  
  if (single && Array.isArray(data)) {
    if (data.length === 0) {
      return { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
    }
    return { data: data[0], error: null };
  }
  
  return { data, error: null };
}


function authFailure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') return NextResponse.json({ error: 'No authorized QuickBooks company is connected' }, { status: 403 });
  return null;
}
// Generate an unguessable token for the company inbox
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function GET() {
  try {
    const { realmId } = await requireAuth();
    const realm_id = realmId;
    const { data: inbox } = await supabaseQuery('company_inboxes', { filter: { realm_id }, single: true });
    const { data: requests } = await supabaseQuery('collection_requests', {
      filter: { realm_id }, order: { column: 'created_at', ascending: false },
    });
    const { data: documents } = await supabaseQuery('inbox_documents', {
      filter: { realm_id }, order: { column: 'uploaded_at', ascending: false },
      isNull: ['archived_at'],
    });
    const inboxLink = inbox
      ? `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/inbox/${inbox.token}`
      : null;
    return NextResponse.json({
      inbox: inbox ? { id: inbox.id, realm_id: inbox.realm_id, token: inbox.token, link: inboxLink, created_at: inbox.created_at } : null,
      requests: requests || [], documents: documents || [],
    });
  } catch (error) {
    const response = authFailure(error);
    if (response) return response;
    console.error('Firm inbox GET error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
export async function POST(request: NextRequest) {
  try {
    const { realmId: authorizedRealmId } = await requireAuth();

    // Parse and validate JSON body
    let body: { realm_id?: string; transaction_ids?: string[] };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { realm_id, transaction_ids: providedTransactionIds } = body;

    // Validate realm_id
    if (!realm_id || typeof realm_id !== 'string' || realm_id.trim() === '') {
      return NextResponse.json({ error: 'realm_id is required and must be non-empty' }, { status: 400 });
    }

    if (realm_id !== authorizedRealmId) {
      return NextResponse.json({ error: 'realm_id is not authorized for this account' }, { status: 403 });
    }

    // Determine transaction_ids: if provided, validate them; otherwise fetch from qbo_evidence_register
    let transactionIds: string[];

    if (providedTransactionIds && Array.isArray(providedTransactionIds) && providedTransactionIds.length > 0) {
      // Validate provided transaction_ids
      for (const txnId of providedTransactionIds) {
        if (!txnId || typeof txnId !== 'string' || txnId.trim() === '') {
          return NextResponse.json({ error: 'All transaction_ids must be non-empty strings' }, { status: 400 });
        }
      }
      transactionIds = providedTransactionIds;
    } else {
      // Fetch transaction IDs from qbo_evidence_register where register_state != 'MATCHED'
      const { data: registerEntries, error: registerError } = await supabaseQuery('qbo_evidence_register', {
        filter: { realm_id },
        select: 'qbo_txn_id,register_state',
      });

      if (registerError) {
        console.error('Error fetching qbo_evidence_register:', registerError);
        return NextResponse.json({ error: 'Failed to fetch evidence register' }, { status: 500 });
      }

      // Filter out MATCHED transactions and get unique qbo_txn_id values
      const entries = (registerEntries || []) as Array<{ qbo_txn_id: string | null; register_state: string }>;
      const nonMatchedEntries = entries.filter(
        (entry) => entry.register_state !== 'MATCHED'
      );

      const uniqueTxnIds = Array.from(
        new Set(nonMatchedEntries.map((entry) => entry.qbo_txn_id).filter(Boolean)) as Set<string>
      );

      if (uniqueTxnIds.length === 0) {
        return NextResponse.json({ error: 'No non-MATCHED transactions found in evidence register for this realm' }, { status: 400 });
      }

      transactionIds = uniqueTxnIds;
    }

    // Find or create company inbox
    let inbox;
    const { data: existingInbox, error: inboxError } = await supabaseQuery('company_inboxes', {
      filter: { realm_id },
      single: true,
    });

    if (inboxError && inboxError.code !== 'PGRST116') {
      console.error('Error fetching company inbox:', inboxError);
      return NextResponse.json({ error: 'Failed to fetch company inbox' }, { status: 500 });
    }

    if (existingInbox) {
      inbox = existingInbox;
    } else {
      // Create new company inbox with unique token
      const token = generateToken();
      const { data: newInbox, error: createInboxError } = await supabaseQuery('company_inboxes', {
        method: 'POST',
        body: { realm_id, token },
        single: true,
      });

      if (createInboxError) {
        console.error('Error creating company inbox:', createInboxError);
        return NextResponse.json({ error: 'Failed to create company inbox' }, { status: 500 });
      }

      inbox = newInbox;
    }

    // Create collection request
    const { data: collectionRequest, error: requestError } = await supabaseQuery('collection_requests', {
      method: 'POST',
      body: {
        realm_id,
        transaction_ids: transactionIds,
        status: 'requested',
      },
      single: true,
    });

    if (requestError) {
      console.error('Error creating collection request:', requestError);
      return NextResponse.json({ error: 'Failed to create collection request' }, { status: 500 });
    }

    // Build the inbox link
    const inboxLink = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/inbox/${inbox.token}`;

    return NextResponse.json({
      collection_request_id: collectionRequest.id,
      company_inbox_id: inbox.id,
      token: inbox.token,
      link: inboxLink,
    }, { status: 201 });
  } catch (error) {
    const response = authFailure(error);
    if (response) return response;
    console.error('Firm inbox POST error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
export async function PATCH() {
  try {
    const { realmId } = await requireAuth();
    const token = generateToken();
    const { data: inbox, error } = await supabaseQuery('company_inboxes', {
      method: 'PATCH',
      filter: { realm_id: realmId },
      select: 'id,realm_id,token,created_at',
      body: { token },
      single: true,
    });

    if (error?.code === 'PGRST116' || !inbox) {
      return NextResponse.json({ error: 'Company inbox not found' }, { status: 404 });
    }
    if (error) {
      console.error('Firm inbox token rotation failed:', error.message);
      return NextResponse.json({ error: 'Failed to rotate inbox link' }, { status: 500 });
    }

    const inboxLink = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/inbox/${inbox.token}`;
    return NextResponse.json({ inbox, link: inboxLink }, { status: 200 });
  } catch (error) {
    const response = authFailure(error);
    if (response) return response;
    console.error('Firm inbox token rotation failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
