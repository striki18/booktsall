import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from } }));

import { downloadAttachableBytes, getTransactionById, uploadAttachable } from '@/lib/quickbooks';

function tokenQuery() {
  const query: Record<string, any> = {};
  for (const method of ['select', 'order', 'limit', 'eq']) query[method] = vi.fn(() => query);
  query.single = vi.fn(async () => ({
    data: {
      realm_id: 'sandbox-1',
      access_token: 'unit-test-access-token',
      refresh_token: 'unit-test-refresh-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    error: null,
  }));
  return query;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'unit-test-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('QBO attachment upload transport', () => {
  it('reads an Expense through its genuine Purchase API entity', async () => {
    mocks.from.mockImplementation(() => tokenQuery());
    const fetch = vi.fn(async (_url: string) => Response.json({ QueryResponse: { Purchase: [{ Id: '107', PaymentType: 'Cash' }] } }));
    vi.stubGlobal('fetch', fetch);
    await expect(getTransactionById('Expense', '107', 'sandbox-1')).resolves.toMatchObject({ transaction: { Id: '107' }, httpStatus: 200 });
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('query')).toBe("SELECT * FROM Purchase WHERE Id = '107'");
  });
  it('follows the documented temporary URL without forwarding OAuth credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test.supabase.co');
    mocks.from.mockImplementation(() => tokenQuery());
    const fetch = vi.fn().mockResolvedValueOnce(new Response('https://intuit-test.s3.amazonaws.com/file?signature=test', { headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('%PDF-real-bytes'));
    vi.stubGlobal('fetch', fetch);
    const result = await downloadAttachableBytes('123', 'sandbox-1');
    expect(result.bytes.toString()).toBe('%PDF-real-bytes');
    expect(fetch.mock.calls[1][1]).toEqual({ method: 'GET', redirect: 'error' });
  });

  it.each(['http://intuit-test.s3.amazonaws.com/file', 'https://localhost/file', 'https://intuit.com.attacker.test/file'])('rejects unsafe temporary locations: %s', async (location) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test.supabase.co');
    mocks.from.mockImplementation(() => tokenQuery());
    const fetch = vi.fn().mockResolvedValue(new Response(location, { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(downloadAttachableBytes('123', 'sandbox-1')).rejects.toThrow('untrusted download location');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ AttachableResponse: [{ Attachable: { Id: 'actual-upload-id' } }] }, { Id: 'actual-upload-id' }],
    [{ AttachableResponse: [{ Fault: { type: 'ValidationFault' } }] }, undefined],
    [{ AttachableResponse: [] }, undefined],
    [{ AttachableResponse: [{ Attachable: { Id: 'one' } }, { Attachable: { Id: 'two' } }] }, undefined],
  ])('handles documented upload envelopes without guessing an identity', async (body, expected) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'unit-test-key');
    mocks.from.mockImplementation(() => tokenQuery());
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await uploadAttachable(Buffer.from('%PDF-test'), 'receipt.pdf', 'application/pdf', 'Invoice', '123', 'sandbox-1');
    expect(result).toEqual({ attachable: expected, httpStatus: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends one multipart upload and returns the QBO attachment identity', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'unit-test-key');
    mocks.from.mockImplementation(() => tokenQuery());
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ Attachable: { Id: 'attachable-1' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);

    const result = await uploadAttachable(Buffer.from('%PDF-test'), 'receipt.pdf', 'application/pdf', 'Invoice', '123', 'sandbox-1');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/v3/company/sandbox-1/upload');
    expect(result).toEqual({ attachable: { Id: 'attachable-1' }, httpStatus: 200 });
  });

  it('does not retry a 429 upload response', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'unit-test-key');
    mocks.from.mockImplementation(() => tokenQuery());
    const fetch = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetch);

    await expect(uploadAttachable(Buffer.from('file'), 'receipt.pdf', 'application/pdf', 'Invoice', '123', 'sandbox-1'))
      .rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
