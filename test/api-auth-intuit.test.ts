import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getStoredToken: vi.fn(),
  cookies: vi.fn(),
  membershipUpsert: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/quickbooks', () => ({ getStoredToken: mocks.getStoredToken }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({ upsert: mocks.membershipUpsert })),
    auth: { admin: { updateUserById: mocks.updateUserById } },
  },
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));

import { GET as startOAuth } from '@/app/api/auth/intuit/route';
import { GET as oauthCallback } from '@/app/api/auth/intuit/callback/route';
import { GET as tokenStatus } from '@/app/api/auth/intuit/token/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membershipUpsert.mockResolvedValue({ error: null });
  mocks.updateUserById.mockResolvedValue({ error: null });
});

describe('QuickBooks OAuth and token-status routes', () => {
  it('requires sign-in before starting OAuth', async () => {
    mocks.requireUser.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await startOAuth();
    expect(response.status).toBe(401);
  });

  it('requires sign-in before processing an OAuth callback', async () => {
    mocks.requireUser.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await oauthCallback(new Request('http://localhost/api/auth/intuit/callback'));
    expect(response.status).toBe(401);
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it('does not expose token information to anonymous callers', async () => {
    mocks.requireUser.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await tokenStatus();
    expect(response.status).toBe(401);
    expect(mocks.getStoredToken).not.toHaveBeenCalled();
  });

  it('returns only non-secret token status scoped to app_metadata realm', async () => {
    mocks.requireUser.mockResolvedValue({ app_metadata: { realm_id: 'realm-1' } });
    mocks.getStoredToken.mockResolvedValue({
      realm_id: 'realm-1', expires_at: '2030-01-01T00:00:00.000Z',
      access_token: 'private-access-token', refresh_token: 'private-refresh-token',
    });

    const response = await tokenStatus();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getStoredToken).toHaveBeenCalledWith('realm-1');
    expect(body).toEqual({ realm_id: 'realm-1', expires_at: '2030-01-01T00:00:00.000Z' });
    expect(JSON.stringify(body)).not.toContain('private-');
  });

  it('registers an OAuth company membership and preserves prior authorized realms', async () => {
    const originalClientId = process.env.INTUIT_CLIENT_ID;
    const originalClientSecret = process.env.INTUIT_CLIENT_SECRET;
    const originalRedirectUri = process.env.INTUIT_REDIRECT_URI;
    const originalRealmId = process.env.INTUIT_REALM_ID;
    const originalFetch = globalThis.fetch;
    try {
      process.env.INTUIT_CLIENT_ID = 'test-client';
      process.env.INTUIT_CLIENT_SECRET = 'test-secret';
      process.env.INTUIT_REDIRECT_URI = 'http://localhost/api/auth/intuit/callback';
      process.env.INTUIT_REALM_ID = '9341458707866620';
      mocks.requireUser.mockResolvedValue({ id: 'user-1', app_metadata: { realm_id: 'realm-1', qbo_realm_ids: ['realm-1'] } });
      mocks.cookies.mockResolvedValue({ get: (name: string) => ({ value: name === 'intuit_oauth_state' ? 'state-ok' : 'verifier-ok' }) });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) }) as typeof fetch;

      const response = await oauthCallback(new Request('http://localhost/api/auth/intuit/callback?code=code&state=state-ok&realmId=9341458707866620'));

      expect(response.status).toBe(307);
      expect(mocks.membershipUpsert).toHaveBeenCalledWith({ user_id: 'user-1', realm_id: '9341458707866620' }, { onConflict: 'user_id,realm_id' });
      expect(mocks.updateUserById).toHaveBeenCalledWith('user-1', {
        app_metadata: { realm_id: '9341458707866620', qbo_realm_ids: ['realm-1', '9341458707866620'] },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalClientId === undefined) delete process.env.INTUIT_CLIENT_ID; else process.env.INTUIT_CLIENT_ID = originalClientId;
      if (originalClientSecret === undefined) delete process.env.INTUIT_CLIENT_SECRET; else process.env.INTUIT_CLIENT_SECRET = originalClientSecret;
      if (originalRedirectUri === undefined) delete process.env.INTUIT_REDIRECT_URI; else process.env.INTUIT_REDIRECT_URI = originalRedirectUri;
      if (originalRealmId === undefined) delete process.env.INTUIT_REALM_ID; else process.env.INTUIT_REALM_ID = originalRealmId;
    }
  });

  it('rejects a non-sandbox realm before token exchange or database writes', async () => {
    const originalRealmId = process.env.INTUIT_REALM_ID;
    const originalFetch = globalThis.fetch;
    try {
      process.env.INTUIT_REALM_ID = '9341458707866620';
      mocks.requireUser.mockResolvedValue({ id: 'user-1', app_metadata: {} });
      globalThis.fetch = vi.fn() as typeof fetch;

      const response = await oauthCallback(new Request('http://localhost/api/auth/intuit/callback?code=code&state=state-ok&realmId=another-company'));

      expect(response.status).toBe(403);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(mocks.cookies).not.toHaveBeenCalled();
      expect(mocks.membershipUpsert).not.toHaveBeenCalled();
      expect(mocks.updateUserById).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalRealmId === undefined) delete process.env.INTUIT_REALM_ID; else process.env.INTUIT_REALM_ID = originalRealmId;
    }
  });

  it('allows an explicitly consented additional company after the first guarded realm', async () => {
    const originalClientId = process.env.INTUIT_CLIENT_ID;
    const originalClientSecret = process.env.INTUIT_CLIENT_SECRET;
    const originalRedirectUri = process.env.INTUIT_REDIRECT_URI;
    const originalRealmId = process.env.INTUIT_REALM_ID;
    const originalFetch = globalThis.fetch;
    try {
      process.env.INTUIT_CLIENT_ID = 'test-client';
      process.env.INTUIT_CLIENT_SECRET = 'test-secret';
      process.env.INTUIT_REDIRECT_URI = 'http://localhost/api/auth/intuit/callback';
      process.env.INTUIT_REALM_ID = 'initial-sandbox';
      mocks.requireUser.mockResolvedValue({ id: 'user-1', app_metadata: { realm_id: 'initial-sandbox', qbo_realm_ids: ['initial-sandbox'] } });
      mocks.cookies.mockResolvedValue({ get: (name: string) => ({ value: name === 'intuit_oauth_state' ? 'state-ok' : 'verifier-ok' }) });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) }) as typeof fetch;

      const response = await oauthCallback(new Request('http://localhost/api/auth/intuit/callback?code=code&state=state-ok&realmId=second-company'));

      expect(response.status).toBe(307);
      expect(mocks.membershipUpsert).toHaveBeenCalledWith({ user_id: 'user-1', realm_id: 'second-company' }, { onConflict: 'user_id,realm_id' });
      expect(mocks.updateUserById).toHaveBeenCalledWith('user-1', {
        app_metadata: { realm_id: 'second-company', qbo_realm_ids: ['initial-sandbox', 'second-company'] },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalClientId === undefined) delete process.env.INTUIT_CLIENT_ID; else process.env.INTUIT_CLIENT_ID = originalClientId;
      if (originalClientSecret === undefined) delete process.env.INTUIT_CLIENT_SECRET; else process.env.INTUIT_CLIENT_SECRET = originalClientSecret;
      if (originalRedirectUri === undefined) delete process.env.INTUIT_REDIRECT_URI; else process.env.INTUIT_REDIRECT_URI = originalRedirectUri;
      if (originalRealmId === undefined) delete process.env.INTUIT_REALM_ID; else process.env.INTUIT_REALM_ID = originalRealmId;
    }
  });
});
describe('OAuth state cookie security', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalClientId = process.env.INTUIT_CLIENT_ID;
  const originalRedirectUri = process.env.INTUIT_REDIRECT_URI;

  it('uses non-secure cookies only for local development and secure cookies in production', async () => {
    try {
      process.env.INTUIT_CLIENT_ID = 'test-client';
      process.env.INTUIT_REDIRECT_URI = 'http://localhost:3000/api/auth/intuit/callback';
      Reflect.set(process.env, 'NODE_ENV', 'development');
      mocks.requireUser.mockResolvedValue({ id: 'user-1' });
      const developmentResponse = await startOAuth();
      expect(developmentResponse.headers.get('set-cookie')).not.toMatch(/; Secure(?:;|$)/i);

      Reflect.set(process.env, 'NODE_ENV', 'production');
      const productionResponse = await startOAuth();
      expect(productionResponse.headers.get('set-cookie')).toMatch(/; Secure(?:;|$)/i);
      expect(productionResponse.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    } finally {
      if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Reflect.set(process.env, 'NODE_ENV', originalNodeEnv);
      if (originalClientId === undefined) delete process.env.INTUIT_CLIENT_ID; else process.env.INTUIT_CLIENT_ID = originalClientId;
      if (originalRedirectUri === undefined) delete process.env.INTUIT_REDIRECT_URI; else process.env.INTUIT_REDIRECT_URI = originalRedirectUri;
    }
  });
});
