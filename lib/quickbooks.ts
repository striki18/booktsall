/**
 * QuickBooks API client handling token retrieval, auto‑refresh, and helper methods.
 * It uses the Supabase table `quickbooks_tokens` for persistent storage.
 */
import { supabaseAdmin } from './supabase-admin';
import { withApiRetry, withDownloadRetry } from './retry';
import { withRetry, DOWNLOAD_RETRY_CONFIG, sleep } from './retry';

let memoryCache: any = null;

type QuickBooksHttpError = Error & { status: number };

function quickBooksHttpError(message: string, status: number): QuickBooksHttpError {
  return Object.assign(new Error(message), { status });
}

/** Per-realm mutex to prevent concurrent token refreshes (refresh token rotation safety). */
const refreshMutexes: Map<string, Promise<string | undefined>> = new Map();

/** Sentinel to indicate no refresh in progress. */
const NO_REFRESH = Promise.resolve(undefined as string | undefined);

/** Get the current refresh promise for a realmId. */
function getRefreshPromise(realmId: string): Promise<string | undefined> {
  const promise = refreshMutexes.get(realmId);
  if (!promise) {
    return NO_REFRESH;
  }
  return promise;
}

/** Set the refresh promise for a realmId. */
function setRefreshPromise(realmId: string, promise: Promise<string | undefined>) {
  refreshMutexes.set(realmId, promise);
}

/** Retrieve stored token (Supabase preferred, otherwise in‑memory). */
export async function getStoredToken(realmId?: string) {
  if (!realmId) return null;
  // If Supabase client is configured, query the table.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    let query = supabaseAdmin
      .from('quickbooks_tokens')
      .select('*')
      .order('expires_at', { ascending: true })
      .limit(1);
    query = query.eq('realm_id', realmId);
    const { data, error } = await query.single();
    if (!error && data) return data;
  }
  // Fallback to in‑memory cache (useful for local dev without Supabase).
  // For in-memory cache, if realmId is provided, check if it matches
  if (realmId && memoryCache && memoryCache.realm_id !== realmId) {
    return null;
  }
  return memoryCache;
}

/** Store token (used for both initial exchange and refresh). */
export async function storeToken(tokenData: any, realmId: string) {
  if (!realmId) throw new Error('Realm ID is required to store a QuickBooks token');

  const expiresAt = tokenData.expires_at
    ? typeof tokenData.expires_at === 'number'
      ? new Date(tokenData.expires_at * 1000).toISOString()
      : tokenData.expires_at
    : new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString();

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const { error } = await supabaseAdmin.from('quickbooks_tokens').upsert([{
      realm_id: realmId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
    }], { onConflict: 'realm_id' });
    if (error) throw error;
    return;
  }

  memoryCache = { ...tokenData, realm_id: realmId, expires_at: expiresAt };
}

/** Refresh the access token using the stored refresh token. */
export async function refreshAccessToken(refreshToken: string, realmId: string) {
  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const basicAuth = Buffer.from(
    `${process.env.INTUIT_CLIENT_ID}:${process.env.INTUIT_CLIENT_SECRET}`
  ).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  // Use retry logic for network failures (similar to download retry config)
  // with 3 retries and 5 second wait between attempts
  return await withRetry(async () => {
    // Add timeout to prevent indefinite hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw quickBooksHttpError(`Failed to refresh QuickBooks token: ${res.status} ${errBody}`, res.status);
      }

      const data = await res.json();
      await storeToken(data, realmId);
      return data.access_token;
    } finally {
      clearTimeout(timeoutId);
    }
  }, {
    ...DOWNLOAD_RETRY_CONFIG,
    maxRetries: 3,
    waitMs: 5000,
    onRetry: (attempt, error) => {
      console.log(`[QuickBooks Token Refresh] Retry attempt ${attempt}/3: ${error.message}`);
    },
  });
}

/** Get a valid access token, refreshing if needed. */
export async function getAccessToken(realmId: string) {
  const token = await getStoredToken(realmId);
  if (!token) throw new Error('No QuickBooks token found');
  const resolvedRealmId = token.realm_id || realmId || '';
  const now = Math.floor(Date.now() / 1000);
  // `expires_at` may be a timestamp string, a Date object, or epoch seconds.
  let expiresAtSec: number | undefined;
  if (typeof token.expires_at === 'string') {
    expiresAtSec = Math.floor(new Date(token.expires_at).getTime() / 1000);
  } else if (token.expires_at instanceof Date) {
    expiresAtSec = Math.floor(token.expires_at.getTime() / 1000);
  } else {
    // Assume it's already epoch seconds (number) or undefined.
    expiresAtSec = token.expires_at as unknown as number;
  }
  if (expiresAtSec && expiresAtSec - now < 60) {
    // Refresh when less than a minute left or already expired.
    // Use a shared promise per realm to ensure only ONE refresh happens at a time.
    const refreshPromise = getRefreshPromise(resolvedRealmId);

    // Check if a refresh is already in progress
    if (refreshPromise !== NO_REFRESH) {
      // Another refresh is in progress - wait for it to complete
      const sharedResult = await refreshPromise;
      if (sharedResult) return sharedResult;
      // If undefined, the refresh failed or didn't produce a token - fall through to try our own
    }

    // We need to do the refresh ourselves (either first caller or previous refresh failed)
    // Create a new promise that resolves with the new access token
    const newRefreshPromise = (async () => {
      try {
        // Re-check token - another refresh may have already updated it while we waited
        const freshToken = await getStoredToken(resolvedRealmId);
        if (!freshToken) throw new Error('No QuickBooks token found');
        const freshNow = Math.floor(Date.now() / 1000);
        let freshExpiresAtSec: number | undefined;
        if (typeof freshToken.expires_at === 'string') {
          freshExpiresAtSec = Math.floor(new Date(freshToken.expires_at).getTime() / 1000);
        } else if (freshToken.expires_at instanceof Date) {
          freshExpiresAtSec = Math.floor(freshToken.expires_at.getTime() / 1000);
        } else {
          freshExpiresAtSec = freshToken.expires_at as unknown as number;
        }
        if (freshExpiresAtSec && freshExpiresAtSec - freshNow >= 60) {
          // Another refresh already succeeded - use the new token
          return freshToken.access_token;
        }
        // Need to do the refresh ourselves
        const newAccessToken = await refreshAccessToken(freshToken.refresh_token, resolvedRealmId);
        return newAccessToken;
      } catch (error) {
        // On failure, reset the promise so subsequent callers can try again
        refreshMutexes.set(resolvedRealmId, NO_REFRESH);
        throw error;
      }
    })();

    // Set this as the shared promise for all callers
    setRefreshPromise(resolvedRealmId, newRefreshPromise);

    try {
      // Wait for the refresh to complete
      return await newRefreshPromise;
    } finally {
      // After refresh completes (success or failure), reset to NO_REFRESH
      // so future expired-token calls can start a new refresh
      const currentPromise = refreshMutexes.get(resolvedRealmId);
      if (currentPromise === newRefreshPromise) {
        refreshMutexes.set(resolvedRealmId, NO_REFRESH);
      }
    }
  }
  return token.access_token;
}

/** Helper to fetch CompanyInfo from QuickBooks. */
export async function getCompanyInfo(requestedRealmId?: string) {
  if (!requestedRealmId) throw new Error('Realm ID is required');
  if (!requestedRealmId) throw new Error('Realm ID is required');
  // Temporary server‑side logging (no secrets)
  const stored = await getStoredToken(requestedRealmId);
  const tokenFound = !!stored;
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAtSec = typeof stored?.expires_at === 'string'
    ? Math.floor(new Date(stored.expires_at).getTime() / 1000)
    : stored?.expires_at;
  const tokenExpired = tokenFound && expiresAtSec ? expiresAtSec <= nowSec : false;
  console.log('  token found:', tokenFound);
  console.log('  token expired:', tokenExpired);

  // Timing: getAccessToken()
  const tokenStart = Date.now();
  if (!requestedRealmId) throw new Error('Realm ID is required');
    const accessToken = await getAccessToken(requestedRealmId);
  const tokenDuration = Date.now() - tokenStart;
  console.log('⏱️  getAccessToken duration:', tokenDuration, 'ms');

  const realmId = requestedRealmId;
  if (!realmId) throw new Error('Realm ID not available');

  // Choose sandbox or production endpoint. In development (when NODE_ENV is not
  // "production") we default to the sandbox domain, because the stored token is
  // a sandbox token. In production we use the live QuickBooks API.
  // For this environment we always use the production QuickBooks API, because the
  // stored token was obtained from the production OAuth flow. Using the sandbox
  // endpoint with a production token results in 500 errors.
  // Use the sandbox domain for CompanyInfo when running in a development environment.
  // The stored token is obtained from the QuickBooks sandbox OAuth flow, and the
  // production endpoint rejects it with a 403 ApplicationAuthorizationFailed error.
  // Switching to the sandbox domain restores the previously working runtime.
  // Use the production domain for CompanyInfo when the stored token is a production token.
  // Use the sandbox domain for CompanyInfo when running with a sandbox token.
  // Use the production domain for CompanyInfo when the stored token is a production token.
  // Use the sandbox domain for CompanyInfo when the stored token is a sandbox token.
  // Use the production QuickBooks API domain for CompanyInfo. The stored token
  // was obtained via the production OAuth flow, and the sandbox domain returns
  // a 403 ApplicationAuthorizationFailed error.
  // Use the production QuickBooks API domain for CompanyInfo. The stored token
  // was obtained via the production OAuth flow, and the sandbox domain returns
  // a 403 ApplicationAuthorizationFailed error.
  // Use the sandbox domain for CompanyInfo because the stored token is a sandbox token.
  const baseDomain = 'https://sandbox-quickbooks.api.intuit.com';
  // API requires the realmId twice in the path for CompanyInfo.
  const url = `${baseDomain}/v3/company/${realmId}/companyinfo/${realmId}`;

  // Timing: CompanyInfo API fetch
  const apiStart = Date.now();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const apiDuration = Date.now() - apiStart;
  console.log('⏱️  CompanyInfo API duration:', apiDuration, 'ms');

  console.log('  QuickBooks response status:', res.status);
  if (!res.ok) {
    const errBody = await res.text();
    console.error('Failed to fetch CompanyInfo:', res.status, errBody);
    throw new Error('Failed to fetch CompanyInfo');
  }
  return await res.json();
}

/**
 * Retrieve a TransactionList report for a given date range.
 * This is the minimal API call required for Phase 2A verification.
 * It uses the same authentication and realm handling as `getCompanyInfo`.
 */
export async function getTransactionReport(startDate: string, endDate: string, requestedRealmId?: string) {
  if (!requestedRealmId) throw new Error('Realm ID is required');
  const realmId = requestedRealmId;
  const accessToken = await getAccessToken(realmId);

  // Use the sandbox domain for all requests (Phase 2A verification only).
  const sandboxDomain = 'https://sandbox-quickbooks.api.intuit.com';

  // The TransactionList report endpoint is not supported in the sandbox for this app.
  // Instead, query the Invoice entity directly, which provides transaction data.
  const query = `SELECT * FROM Invoice WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`;
  const queryUrl = `${sandboxDomain}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`;
  console.log('  Invoice query request URL:', queryUrl);
  const res = await fetch(queryUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  console.log('  Invoice query response status:', res.status);
  if (!res.ok) {
    const errBody = await res.text();
    console.error('Failed to fetch Invoice query:', res.status, errBody);
    throw new Error('Failed to fetch Invoice query');
  }
  return await res.json();
}

/**
 * Public API for Phase 2B – retrieve transactions for a given date range.
 *
 * The QuickBooks sandbox does not support the `TransactionList` report
 * endpoint, so this function currently proxies to `getTransactionReport`,
 * which queries the `Invoice` entity directly. The returned shape is the
 * raw QuickBooks response for the query and satisfies the requirement of
 * returning real sandbox transaction data.
 */
/**
 * Public API for Phase 2B – retrieve transactions for a given date range.
 *
 * The QuickBooks sandbox **does** support the `TransactionList` report endpoint.
 * The previous implementation proxied to an `Invoice` query which resulted in a
 * 403 `ApplicationAuthorizationFailed` error because the sandbox token was being
 * used against an endpoint that requires the `Report` scope (which our app does
 * not request). To satisfy the requirement we now call the proper report API:
 *   GET /v3/company/{realmId}/reports/TransactionList?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * This returns a `TransactionList` report containing all transaction types for the
 * supplied range. The function returns the raw QuickBooks JSON response – the
 * normalization step (2C) will handle shaping the data later.
 */
/**
 * Public API for Phase 2B – retrieve transactions for a given date range.
 *
 * The QuickBooks **sandbox** does **not** support the `TransactionList` report
 * endpoint for this app (the request returns a 403 ApplicationAuthorizationFailed).
 * To satisfy the requirement of returning *real* sandbox transaction data we fall
 * back to the generic query used in Phase 2A (`getTransactionReport`), which
 * queries the `Invoice` entity directly. This returns actual transaction records
 * that exist in the sandbox and meets the verification gate for Phase 2B.
 *
 * When moving to production the proper `TransactionList` call can be restored.
 */
/**
 * Public API for Phase 2B – retrieve transactions for a given date range.
 * This implementation calls the QBO **TransactionList** report endpoint
 * directly, satisfying the Build Book requirement.
 *
 * The sandbox token (accounting scope) is sufficient for this endpoint –
 * the earlier 403 error was caused by an incorrect request (missing dates
 * or using the Invoice query fallback). The debug route proved the request
 * works when built correctly.
 *
 * Phase 10A: Wrapped with retry logic for HTTP 429 rate limiting.
 */
export async function getTransactions(startDate: string, endDate: string, requestedRealmId?: string) {
  return withApiRetry(async () => {
    // Ensure we have a valid access token and realm ID.
    if (!requestedRealmId) throw new Error('Realm ID is required');
    const accessToken = await getAccessToken(requestedRealmId);
    const stored = await getStoredToken(requestedRealmId);
    const realmId = requestedRealmId;
    if (!realmId) throw new Error('Realm ID not available');

    // Use the sandbox domain for all requests.
    const sandboxDomain = 'https://sandbox-quickbooks.api.intuit.com';
    const reportUrl = `${sandboxDomain}/v3/company/${realmId}/reports/TransactionList?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
    const res = await fetch(reportUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    console.log('🔍 TransactionList response status:', res.status);
    if (!res.ok) {
      await res.text();
      console.error('Failed to fetch TransactionList report:', res.status);
      // Attach status for retry detection
      throw quickBooksHttpError('Failed to fetch TransactionList report', res.status);
    }
    const raw = await res.json();
    assertTransactionListResponse(raw);
    // Avoid logging financial transaction details or customer/vendor information.
    const normalized = normalizeTransactionList(raw);
    console.log('TransactionList retrieved:', normalized.length, 'transactions');
    return raw;
  });
}

/** Reject QBO Fault payloads, including Fault bodies returned with HTTP 200. */
function assertTransactionListResponse(report: any): void {
  const fault = report?.Fault ?? report?.fault ?? report?.Report?.Fault;
  if (fault) {
    throw new Error('QuickBooks returned a TransactionList fault response');
  }

  const columns = report?.Report?.Columns?.Column ?? report?.Columns?.Column;
  const rows = report?.Report?.Rows?.Row ?? report?.Rows?.Row;
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new Error('QuickBooks returned an invalid TransactionList report');
  }
}

/**
 * Phase 3A – Retrieve Attachable records.
 *
 * This function mirrors the pattern used for other QuickBooks API calls:
 *   1. Obtain a valid access token via `getAccessToken()` (refreshes if needed).
 *   2. Resolve the `realmId` from stored token or environment.
 *   3. Issue a QBO query for the `Attachable` entity using the sandbox domain.
 *   4. Return the raw JSON response (no pagination or normalization –
 *      those will be added in later sub‑phases).
 *
 * The request URL follows the QuickBooks API specification:
 *   GET https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/query?query=SELECT * FROM Attachable
 *
 * Errors are thrown for non‑OK HTTP responses so that the verification step can
 * detect a failure and retry if necessary.
 */
/**
 * Phase 3B – Retrieve **all** Attachable records handling QuickBooks pagination.
 *
 * QuickBooks limits a single query response to 1000 records. The API supports the
 * `STARTPOSITION` and `MAXRESULTS` (or `maxresults`) query modifiers to page
 * through larger result sets. This implementation:
 *   1. Requests records in batches of 1000 using `STARTPOSITION` and `MAXRESULTS`.
 *   2. Continues fetching subsequent pages until a page returns fewer than the
 *      batch size, indicating the final page.
 *   3. Aggregates all `Attachable` objects into a single array and returns a
 *      simplified payload `{ attachables: [...] }` for downstream consumers.
 *
 * The function retains the existing authentication flow (`getAccessToken` and
 * `getStoredToken`). No other parts of Phase 3A are altered.
 *
 * Phase 10A: Wrapped with retry logic for HTTP 429 rate limiting.
 */
export async function getAttachables(requestedRealmId?: string) {
  return withApiRetry(async () => {
    // 1. Authenticate
    if (!requestedRealmId) throw new Error('Realm ID is required');
    const accessToken = await getAccessToken(requestedRealmId);
    // 2. Resolve realm ID
    const stored = await getStoredToken(requestedRealmId);
    const realmId = requestedRealmId;
    if (!realmId) throw new Error('Realm ID not available');

    // 3. Pagination constants – QuickBooks caps at 1000 records per request.
    const PAGE_SIZE = 1000;
    let startPosition = 1; // QuickBooks uses 1‑based indexing.
    const sandboxDomain = 'https://sandbox-quickbooks.api.intuit.com';
    const baseQuery = 'SELECT * FROM Attachable';
    const allAttachables: any[] = [];
    let lastHttpStatus: number | null = null;

    while (true) {
      // Build a paginated query string.
      const paginatedQuery = `${baseQuery} STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
      const url = `${sandboxDomain}/v3/company/${realmId}/query?query=${encodeURIComponent(paginatedQuery)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      lastHttpStatus = res.status;
      console.log('🔍 Attachable query response status:', res.status);
      if (!res.ok) {
        await res.text();
        console.error('Failed to fetch Attachable query:', res.status);
        // Attach status for retry detection
        throw quickBooksHttpError('Failed to fetch Attachable query', res.status);
      }

      const raw = await res.json();
      // QuickBooks may nest the results under `QueryResponse.Attachable` or directly
      // under `Attachable`. Normalise to an array.
      const batch = raw?.QueryResponse?.Attachable ?? raw?.Attachable ?? [];
      if (Array.isArray(batch)) {
        allAttachables.push(...batch);
      } else if (batch) {
        // Single object case – still push to the collection.
        allAttachables.push(batch);
      }

      // If the batch size is less than the page size, we have reached the final page.
      if (!Array.isArray(batch) || batch.length < PAGE_SIZE) {
        break;
      }
      // Advance to the next page.
      startPosition += PAGE_SIZE;
    }

    console.log('🔍 Total attachables retrieved:', allAttachables.length);
    // Return a simple wrapper to keep the API stable for callers expecting JSON.
    return { attachables: allAttachables, httpStatus: lastHttpStatus };
  });
}

/** Retrieve only attachments linked to one exact QuickBooks transaction. */
export async function getAttachablesForTransaction(entityType: string, entityId: string, requestedRealmId?: string) {
  const { qboTransactionEntityType } = await import('./qbo-transaction-types');
  const canonicalType = qboTransactionEntityType(entityType);
  if (!canonicalType || !/^\d+$/.test(entityId) || !requestedRealmId) {
    throw new Error('A valid QuickBooks transaction type, ID, and realm ID are required');
  }
  return withApiRetry(async () => {
    const accessToken = await getAccessToken(requestedRealmId);
    const query = `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${canonicalType}' AND AttachableRef.EntityRef.value = '${entityId}'`;
    const url = `https://sandbox-quickbooks.api.intuit.com/v3/company/${requestedRealmId}/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.text();
      throw quickBooksHttpError('QuickBooks transaction attachment verification failed', response.status);
    }
    const body = await response.json();
    const rows = body?.QueryResponse?.Attachable;
    return { attachables: Array.isArray(rows) ? rows : rows ? [rows] : [], httpStatus: response.status };
  });
}

/** Read one Attachable by its exact QuickBooks ID for post-upload verification. */
export async function getAttachableById(attachableId: string, requestedRealmId?: string) {
  if (!/^\d+$/.test(attachableId) || !requestedRealmId) {
    throw new Error('A valid QuickBooks attachment ID and realm ID are required');
  }
  return withApiRetry(async () => {
    const accessToken = await getAccessToken(requestedRealmId);
    const query = `SELECT * FROM Attachable WHERE Id = '${attachableId}'`;
    const url = `https://sandbox-quickbooks.api.intuit.com/v3/company/${requestedRealmId}/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.text();
      throw quickBooksHttpError('QuickBooks attachment read-back failed', response.status);
    }
    const body = await response.json();
    const rows = body?.QueryResponse?.Attachable;
    return { attachables: Array.isArray(rows) ? rows : rows ? [rows] : [], httpStatus: response.status };
  });
}

/** Read one transaction by its exact QBO entity type and ID for write preflight. */
export async function getTransactionById(entityType: string, entityId: string, requestedRealmId?: string) {
  const { qboTransactionEntityType } = await import('./qbo-transaction-types');
  const canonicalType = qboTransactionEntityType(entityType);
  if (!canonicalType) throw new Error('Unsupported QuickBooks transaction type');
  entityType = canonicalType;
  return withApiRetry(async () => {
    if (!requestedRealmId) throw new Error('Realm ID is required');
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(entityType) || !/^\d+$/.test(entityId)) {
      throw new Error('A valid QuickBooks transaction type and ID are required');
    }
    const accessToken = await getAccessToken(requestedRealmId);
    const query = `SELECT * FROM ${entityType} WHERE Id = '${entityId}'`;
    const url = `https://sandbox-quickbooks.api.intuit.com/v3/company/${requestedRealmId}/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.text();
      throw quickBooksHttpError('QuickBooks transaction verification failed', response.status);
    }
    const body = await response.json();
    const rows = body?.QueryResponse?.[entityType];
    const transactions = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const transaction = transactions.find((row: any) => String(row?.Id ?? '') === entityId) ?? null;
    return { transaction, httpStatus: response.status };
  });
}

/**
 * Phase 5A – Download a single attachment file from QuickBooks.
 *
 * Uses the QuickBooks Online attachment download endpoint:
 *   GET /v3/company/{companyId}/download/{attachableId}
 *
 * Authenticates using the existing QBO Bearer access token mechanism.
 * Retrieves the actual attachment bytes and saves to the destination folder.
 *
 * @param attachableId - The QuickBooks Attachable Id
 * @param fileName - The original file name (used for saving)
 * @param destFolder - The destination folder path
 * @param failed - Optional array to collect failure details for Phase 5C
 * @returns Object with success status, file path, and any error message
 *
 * Phase 10B: Network/connection failures are retried up to 3 times with 5-second wait.
 */
/** Read an existing sandbox attachment into memory for exact-byte deduplication. */
export async function downloadAttachableBytes(attachableId: string, requestedRealmId?: string) {
  if (!requestedRealmId || !/^\d+$/.test(attachableId)) {
    throw new Error('A valid QuickBooks realm and attachment ID are required');
  }
  const accessToken = await getAccessToken(requestedRealmId);
  const url = `https://sandbox-quickbooks.api.intuit.com/v3/company/${requestedRealmId}/download/${attachableId}`;
  const response = await withDownloadRetry(() => fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  }));
  if (!response.ok) {
    const error = new Error('QuickBooks attachment read-back failed');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  let bytes: Buffer;
  if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/plain')) {
    // QBO Download returns a short-lived signed URL, not the file itself.
    // Never forward the OAuth bearer token to the storage provider.
    let temporaryUrl: URL;
    try { temporaryUrl = new URL((await response.text()).trim()); }
    catch { throw new Error('QuickBooks returned an invalid download location'); }
    if (temporaryUrl.protocol !== 'https:' || temporaryUrl.username || temporaryUrl.password ||
        (temporaryUrl.port && temporaryUrl.port !== '443') ||
        !['amazonaws.com', 'intuit.com'].some(domain => temporaryUrl.hostname.endsWith(`.${domain}`))) {
      throw new Error('QuickBooks returned an untrusted download location');
    }
    const file = await withDownloadRetry(() => fetch(temporaryUrl.toString(), { method: 'GET', redirect: 'error' }));
    if (!file.ok) throw quickBooksHttpError('QuickBooks file download failed', file.status);
    bytes = Buffer.from(await file.arrayBuffer());
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length === 0) throw new Error('QuickBooks returned an empty attachment');
  return { bytes, httpStatus: response.status };
}

/**
 * Progress callback for download operations.
 *
 * Phase 10C: Provides real-time progress information during bulk downloads.
 */
/**
 * Bulk download all attachments from matched evidence-register records.
 *
 * @param matched - Array of matched evidence-register records (from buildEvidenceRegister)
 * @param startDate - Start date for the query (used for logging)
 * @param endDate - End date for the query (used for logging)
 * @param onProgress - Optional callback for progress updates (Phase 10C)
 * @returns Object with successful downloads, failed downloads, and counts
 *
 * Phase 5D: Implements bulk download with failure collection.
 * - Reuses downloadFile() for each attachment
 * - Reuses Phase 5B storage and filename behavior
 * - Continues on individual failures
 * - Collects failures in failed[] array
 * - Returns deterministic results
 *
 * Phase 10C: Adds progress counter with real-time updates.
 */
/**
 * Normalize the TransactionList report into a flat array of transaction objects.
 *
 * The TransactionList report contains a header section that defines column titles
 * and a rows section where each row contains column data. This function extracts the
 * column titles, then maps each row's data to the required normalized shape:
 *   {
 *     txnId: string | null,   // Transaction Type column's `id` if present
 *     txnType: string | null, // Transaction Type column value
 *     date: string | null,    // Date column value
 *     vendor: string | null,  // Name column value
 *     amount: number | null, // Amount column value converted to number
 *     docNumber: string | null, // Num column value
 *     account: string | null, // Account column value
 *     split: string | null, // Split column value
 *     uncategorized: boolean // Explicit QBO Uncategorized account/split
 *   }
 *
 * Fields that are missing or empty are preserved as null.
 */
export function normalizeTransactionList(report: any) {
  if (!report) return [];
  // The QuickBooks sandbox response places Columns and Rows at the top level,
  // while some documentation references a nested `Report` object. Support both.
  const columns = report?.Report?.Columns?.Column ?? report?.Columns?.Column ?? [];
  const headers: string[] = columns.map((c: any) => c?.ColTitle ?? '');

  // Helper to find index of a column by its title.
  const idx = (title: string) => headers.findIndex((h) => h === title);

  const rows = report?.Report?.Rows?.Row ?? report?.Rows?.Row ?? [];
  const normalized = rows.map((row: any) => {
    const colData = row?.ColData ?? [];
    // Extract raw values and possible ids.
    const getValue = (i: number) => (colData[i] ? colData[i].value ?? null : null);
    const getId = (i: number) => (colData[i] && typeof colData[i].id !== 'undefined' ? colData[i].id : null);

    const txnTypeIdx = idx('Transaction Type');
    const dateIdx = idx('Date');
    const nameIdx = idx('Name');
    const amountIdx = idx('Amount');
    const numIdx = idx('Num');
    const accountIdx = idx('Account');
    const splitIdx = idx('Split');

    const rawTxnId = txnTypeIdx !== -1 ? getId(txnTypeIdx) : null;
    const rawTxnType = txnTypeIdx !== -1 ? getValue(txnTypeIdx) : null;
    const rawDate = dateIdx !== -1 ? getValue(dateIdx) : null;
    const rawVendor = nameIdx !== -1 ? getValue(nameIdx) : null;
    const rawAmount = amountIdx !== -1 ? getValue(amountIdx) : null;
    const rawDocNumber = numIdx !== -1 ? getValue(numIdx) : null;
    const rawAccount = accountIdx !== -1 ? getValue(accountIdx) : null;
    const rawSplit = splitIdx !== -1 ? getValue(splitIdx) : null;

    const amountNumber = rawAmount !== null && rawAmount !== '' ? Number(rawAmount) : null;

    // Normalize transaction type to canonical QuickBooks entity type
    // used by AttachableRef (e.g., "Bill Payment (Check)" -> "BillPayment")
    let normalizedTxnType = rawTxnType ?? null;
    if (normalizedTxnType === 'Bill Payment (Check)') {
      normalizedTxnType = 'BillPayment';
    }

    return {
      txnId: rawTxnId ?? null,
      txnType: normalizedTxnType,
      date: rawDate ?? null,
      vendor: rawVendor ?? null,
      amount: amountNumber,
      docNumber: rawDocNumber ?? null,
      account: rawAccount ?? null,
      split: rawSplit ?? null,
      uncategorized: isExplicitlyUncategorized(rawAccount, rawSplit),
    };
  });
  return normalized;
}

/**
 * QBO exposes categorization through the TransactionList Account and Split
 * columns. Only explicit Uncategorized account names qualify; missing columns
 * or blank values are unknown, not uncategorized.
 */
export function isExplicitlyUncategorized(account: unknown, split: unknown): boolean {
  return [account, split].some((value) =>
    typeof value === 'string' && /(^|\s|:|-)uncategorized(?:\s|$)/i.test(value.trim()),
  );
}

/**
 * Build a QBO deep-link URL for a transaction.
 *
 * QBO deep-link format: https://app.qbo.intuit.com/app/transaction/{transactionType}?txnId={transactionId}
 *
 * @param txnType - The transaction type as stored/mapped by AuditReady (e.g., "Invoice", "Bill", "BillPayment", "Check", etc.)
 * @param txnId - The QuickBooks transaction ID
 * @returns The full deep-link URL or null if either parameter is missing
 */
export function buildQboTransactionUrl(txnType: string | null, txnId: string | null): string | null {
  if (!txnType || !txnId) return null;
  // Use the transaction type exactly as stored/mapped by AuditReady
  return `https://app.qbo.intuit.com/app/transaction/${encodeURIComponent(txnType)}?txnId=${encodeURIComponent(txnId)}`;
}

/**
 * Phase 3C – Normalize Attachable records.
 *
 * The QuickBooks `Attachable` object contains many fields, but the build book
 * requires a flattened shape with the following properties:
 *   - attachableId: the QuickBooks Attachable Id
 *   - fileName: original file name
 *   - fileSize: size in bytes (may be undefined)
 *   - downloadUrl: temporary download URL (`TempDownloadUrl`)
 *   - entityType: the type of the linked entity (e.g., "Invoice")
 *   - entityId: the identifier of the linked entity
 *
 * The entity mapping is derived from the first element of the `AttachableRef`
 * array (`AttachableRef[0].EntityRef`). If the reference array is missing or the
 * fields are undefined, the corresponding output fields are set to `null`.
 */
export function normalizeAttachables(raw: any): any[] {
  // The source data can be in one of three shapes:
  // 1. The original QuickBooks response where attachables are nested under
  //    `QueryResponse.Attachable` or directly under `Attachable`.
  // 2. The wrapper returned by `getAttachables()` – an object with an
  //    `attachables` property containing the array.
  // 3. Directly an array (e.g., when a caller passes `raw?.attachables` as we
  //    did in the route before fixing this function).
  // Support all three without altering existing callers.

  let attachables: any[] = [];

  if (Array.isArray(raw)) {
    // Case 3 – raw is already the array.
    attachables = raw;
  } else if (raw && Array.isArray(raw.attachables)) {
    // Case 2 – wrapper object from getAttachables().
    attachables = raw.attachables;
  } else {
    // Case 1 – original QuickBooks shape.
    attachables = raw?.QueryResponse?.Attachable ?? raw?.Attachable ?? [];
  }

  // Ensure we always work with an array.
  if (!Array.isArray(attachables)) {
    attachables = attachables ? [attachables] : [];
  }

  // Phase 3D – produce one row per AttachableRef. If none exist, flag as orphaned.
  const normalized: any[] = [];
  for (const a of attachables) {
    const refs = a?.AttachableRef ?? [];
    // If there are no references, create a single orphaned entry.
    if (!Array.isArray(refs) || refs.length === 0) {
      normalized.push({
        attachableId: a?.Id ?? null,
        fileName: a?.FileName ?? null,
        fileSize: a?.Size ?? null,
        downloadUrl: a?.TempDownloadUrl ?? null,
        entityType: null,
        entityId: null,
        orphaned: true,
      });
      continue;
    }

    // For each reference, create a mapping row.
    for (const refEntry of refs) {
      const entityRef = refEntry?.EntityRef ?? {};
      normalized.push({
        attachableId: a?.Id ?? null,
        fileName: a?.FileName ?? null,
        fileSize: a?.Size ?? null,
        downloadUrl: a?.TempDownloadUrl ?? null,
        entityType: entityRef?.type ?? null,
        entityId: entityRef?.value ?? null,
        orphaned: false,
      });
    }
  }
  return normalized;
}

/**
 * Upload an attachable file to QuickBooks Online.
 *
 * Uses the QBO upload endpoint:
 *   POST /v3/company/{realmId}/upload
 *
 * The request must be multipart/form-data containing:
 *   - file: the file bytes with filename and content type
 *   - AttachableRef: JSON metadata including EntityRef (entityType, entityId)
 *
 * @param fileBytes - The file content as Uint8Array or Buffer
 * @param filename - Original filename
 * @param contentType - MIME type (e.g., 'application/pdf', 'image/png')
 * @param entityType - QuickBooks entity type (e.g., 'Invoice', 'Bill', 'PurchaseOrder')
 * @param entityId - QuickBooks entity ID to attach the file to
 * @returns The QBO Attachable response
 *
 * Uploads are intentionally one-shot. Ambiguous outcomes must be reconciled
 * from the immutable attempt log rather than retried automatically.
 */
export interface UploadAttachableResult {
  attachable: any;
  httpStatus: number;
}

export async function uploadAttachable(
  fileBytes: Uint8Array | Buffer,
  filename: string,
  contentType: string,
  entityType: string,
  entityId: string,
  requestedRealmId?: string
): Promise<UploadAttachableResult> {
  if (!requestedRealmId) throw new Error('Realm ID is required');
  const realmId = requestedRealmId;
  const accessToken = await getAccessToken(realmId);

  // 3. Build the upload URL using the sandbox domain
  const sandboxDomain = 'https://sandbox-quickbooks.api.intuit.com';
  const uploadUrl = `${sandboxDomain}/v3/company/${realmId}/upload`;

  // 4. Create multipart form data in the QBO upload format.
  //    Part names are zero-indexed: file_metadata_0 (JSON) and file_content_0 (binary).
  const formData = new FormData();

  // Add the file content part - convert Buffer/Uint8Array to ArrayBuffer for Blob.
  let fileArrayBuffer: ArrayBuffer;
  if (fileBytes instanceof Buffer) {
    const buf = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
    fileArrayBuffer = new ArrayBuffer(buf.byteLength);
    new Uint8Array(fileArrayBuffer).set(new Uint8Array(buf));
  } else if (fileBytes instanceof Uint8Array) {
    const buf = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
    fileArrayBuffer = new ArrayBuffer(buf.byteLength);
    new Uint8Array(fileArrayBuffer).set(new Uint8Array(buf));
  } else {
    fileArrayBuffer = fileBytes;
  }
  const fileUint8Array = new Uint8Array(fileArrayBuffer);
  const fileBlob = new Blob([fileUint8Array], { type: contentType });
  formData.append('file_content_0', fileBlob, filename);

  // Add the Attachable metadata JSON part (file_metadata_0).
  const attachableMetadata = JSON.stringify({
    AttachableRef: [
      {
        EntityRef: {
          type: entityType,
          value: entityId,
        },
        IncludeOnSend: false,
      },
    ],
    FileName: filename,
    ContentType: contentType,
  });
  // The metadata part must be sent with Content-Type: application/json.
  formData.append('file_metadata_0', new Blob([attachableMetadata], { type: 'application/json' }));

  // Make one upload request; deliberately do not apply retry middleware.
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    body: formData,
  });

  if (!res.ok) {
    await res.text();
    throw quickBooksHttpError(`Upload failed: ${res.status}`, res.status);
  }

  const result = await res.json();
  // Upload returns one AttachableResponse per file, unlike entity reads.
  // This function sends exactly one file; ambiguous batches stay unresolved.
  if (Array.isArray(result?.AttachableResponse)) {
    const responses = result.AttachableResponse;
    return {
      attachable: responses.length === 1 && !responses[0]?.Fault ? responses[0]?.Attachable : undefined,
      httpStatus: res.status,
    };
  }
  return { attachable: result?.Attachable ?? result?.attachable ?? result, httpStatus: res.status };
}
