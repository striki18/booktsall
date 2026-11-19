import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));

import { GET, PATCH, POST } from '@/app/api/firm/inbox/route';

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

describe('firm inbox API authorization', () => {
  it('does not query Supabase for anonymous users', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));

    const result = await GET();

    expect(result.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('scopes all reads to the authenticated realm', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any)
      .mockResolvedValueOnce(response([{ id: 'i1', realm_id: 'realm-1', token: 'secret-link-token' }]))
      .mockResolvedValueOnce(response([{ id: 'r1', realm_id: 'realm-1', transaction_ids: [] }]))
      .mockResolvedValueOnce(response([{ id: 'd1', realm_id: 'realm-1', filename: 'receipt.pdf' }]));

    const result = await GET();
    const body = await result.json();

    expect(result.status).toBe(200);
    expect(body.inbox.realm_id).toBe('realm-1');
    expect((fetch as any).mock.calls).toHaveLength(3);
    for (const [url] of (fetch as any).mock.calls) {
      expect(String(url)).toContain('realm_id=eq.realm-1');
    }
  });

  it('rejects a caller-supplied realm different from the authenticated one', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    const request = new Request('http://localhost/api/firm/inbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ realm_id: 'realm-2', transaction_ids: ['txn-1'] }),
    });

    const result = await POST(request as any);

    expect(result.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('generates a high-entropy token for a new inbox', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any)
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{ id: 'i1', realm_id: 'realm-1', token: 'x'.repeat(43) }]))
      .mockResolvedValueOnce(response([{ id: 'r1', realm_id: 'realm-1', transaction_ids: ['txn-1'] }]));
    const request = new Request('http://localhost/api/firm/inbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ realm_id: 'realm-1', transaction_ids: ['txn-1'] }),
    });

    const result = await POST(request as any);
    const body = await result.json();

    expect(result.status).toBe(201);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((fetch as any).mock.calls).toHaveLength(3);
    const createBody = JSON.parse((fetch as any).mock.calls[1][1].body);
    expect(createBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
describe('firm inbox token rotation', () => {
  it('rotates only the authenticated realm token', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    (fetch as any).mockResolvedValueOnce(response([{ id: 'inbox-1', realm_id: 'realm-1', token: 'rotated-token', created_at: '2026-01-01' }]));

    const result = await PATCH();
    const body = await result.json();
    const [url, options] = (fetch as any).mock.calls[0];

    expect(result.status).toBe(200);
    expect(body.inbox.token).toBe('rotated-token');
    expect(String(url)).toContain('realm_id=eq.realm-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not rotate a token for anonymous callers', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));

    const result = await PATCH();

    expect(result.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});