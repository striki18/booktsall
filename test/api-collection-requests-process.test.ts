/**
 * Mocked tests for app/api/collection-requests/[id]/process/route.ts
 * 
 * Tests cover:
 * - Invalid UUID
 * - Unauthenticated request
 * - Missing collection request
 * - Cross-realm access rejected before processing
 * - Authorized processing success
 * - Processing and database failures
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock dependencies at module boundaries
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
  getCurrentUser: vi.fn(),
  getUserRealmId: vi.fn(),
  getServerAuth: vi.fn(),
}));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(),
        })),
      })),
    })),
  },
}));

vi.mock('@/lib/document-extraction', () => ({
  processCollectionRequestDocuments: vi.fn(),
}));

vi.mock('@/lib/qbo-evidence-register', () => ({
  updateRegisterForDocument: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextRequest: vi.fn(),
  NextResponse: {
    json: vi.fn((body: any, init?: any) => ({ body, init })),
  },
}));

import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { processCollectionRequestDocuments } from '@/lib/document-extraction';
import { updateRegisterForDocument } from '@/lib/qbo-evidence-register';
import { NextResponse as MockNextResponse } from 'next/server';

// Import the route handler dynamically
let routeModule: any;

beforeEach(async () => {
  vi.clearAllMocks();
  
  // Reset NextResponse.json mock
  (MockNextResponse.json as any).mockImplementation((body, init) => ({
    body,
    init: init || {},
    status: init?.status || 200,
    json: async () => body,
  }));

  // Import the route module fresh
  vi.resetModules();
  routeModule = await import('@/app/api/collection-requests/[id]/process/route');
});

afterEach(() => {
  vi.resetAllMocks();
});

const createMockRequest = (params: { id: string }) => {
  const mockRequest = {
    method: 'POST',
    nextUrl: {
      searchParams: new URLSearchParams(),
    },
  };
  return mockRequest;
};

describe('app/api/collection-requests/[id]/process/route.ts - POST', () => {
  const validCollectionRequestId = '123e4567-e89b-12d3-a456-426614174000';
  const mockUser = { id: 'user_123' };
  const mockRealmId = 'realm_123';

  describe('Invalid UUID', () => {
    it('should return 400 for invalid UUID format', async () => {
      const mockRequest = createMockRequest({ id: 'invalid-uuid' });
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve({ id: 'invalid-uuid' }) });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('Invalid id');
    });

    it('should return 400 for empty id', async () => {
      const mockRequest = createMockRequest({ id: '' });
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve({ id: '' }) });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('Invalid id');
    });

    it('should return 400 for missing id', async () => {
      const mockRequest = createMockRequest({ id: undefined as any });
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve({ id: undefined as any }) });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('Invalid id');
    });

    it('should return 400 for malformed UUID (too short)', async () => {
      const mockRequest = createMockRequest({ id: '123e4567' });
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve({ id: '123e4567' }) });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('Invalid id');
    });

    it('should return 400 for malformed UUID (wrong format)', async () => {
      const mockRequest = createMockRequest({ id: '123e4567-e89b-12d3-a456' });
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve({ id: '123e4567-e89b-12d3-a456' }) });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('Invalid id');
    });
  });

  describe('Unauthenticated Request', () => {
    beforeEach(() => {
      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      routeModule.POST(mockRequest, { params: Promise.resolve(params) });
    });

    it('should return 401 when unauthenticated', async () => {
      (requireAuth as any).mockRejectedValue(new Error('UNAUTHORIZED'));

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(401);
      expect(json.error).toBe('Unauthorized');
    });

    it('should return 400 when no realm ID', async () => {
      (requireAuth as any).mockRejectedValue(new Error('NO_REALM_ID'));

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('No realm ID associated with user');
    });

    it('should return 403 when forbidden', async () => {
      (requireAuth as any).mockRejectedValue(new Error('FORBIDDEN'));

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('Forbidden: Cannot access other realm data');
    });
  });

  describe('Missing Collection Request', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
    });

    it('should return 404 when collection request not found', async () => {
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(404);
      expect(json.error).toBe('Collection request not found');
    });

    it('should return 404 when database error on fetch', async () => {
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error', code: 'ERROR' } });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(404);
      expect(json.error).toBe('Collection request not found');
    });
  });

  describe('Cross-Realm Access Rejected Before Processing', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
    });

    it('should return 403 when collection request belongs to different realm', async () => {
      const mockSingle = vi.fn().mockResolvedValue({ 
        data: { realm_id: 'different_realm' }, 
        error: null 
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('Forbidden: Cannot process collection request for another realm');
      // Should NOT call processCollectionRequestDocuments
      expect(processCollectionRequestDocuments).not.toHaveBeenCalled();
    });
  });

  describe('Authorized Processing Success', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
    });

    it('should return 200 with results on successful processing', async () => {
      const mockCollectionRequest = { realm_id: mockRealmId };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockCollectionRequest, error: null });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const mockProcessResults = [
        {
          matchResult: {
            documentId: 'doc_1',
            qboTxnId: 'txn_1',
            confidence: 95,
            matchType: 'EXACT',
          },
          extractedFields: { amount: 100, date: '2023-01-15' },
          isDuplicate: false,
          duplicateOfDocumentId: null,
        },
        {
          matchResult: {
            documentId: 'doc_2',
            qboTxnId: 'txn_2',
            confidence: 85,
            matchType: 'FUZZY',
          },
          extractedFields: { amount: 200, date: '2023-01-16' },
          isDuplicate: false,
          duplicateOfDocumentId: null,
        },
      ];

      (processCollectionRequestDocuments as any).mockResolvedValue(mockProcessResults);
      (updateRegisterForDocument as any).mockResolvedValue(undefined);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json).toHaveLength(2);
      expect(json[0].matchResult.documentId).toBe('doc_1');
      expect(json[1].matchResult.documentId).toBe('doc_2');
      
      // Verify processCollectionRequestDocuments was called with correct ID
      expect(processCollectionRequestDocuments).toHaveBeenCalledWith(validCollectionRequestId);
      
      // Verify updateRegisterForDocument was called for each result
      expect(updateRegisterForDocument).toHaveBeenCalledTimes(2);
      expect(updateRegisterForDocument).toHaveBeenCalledWith(
        'doc_1',
        mockRealmId,
        validCollectionRequestId,
        mockProcessResults[0].matchResult,
        mockProcessResults[0].extractedFields,
        mockProcessResults[0].isDuplicate,
        mockProcessResults[0].duplicateOfDocumentId
      );
      expect(updateRegisterForDocument).toHaveBeenCalledWith(
        'doc_2',
        mockRealmId,
        validCollectionRequestId,
        mockProcessResults[1].matchResult,
        mockProcessResults[1].extractedFields,
        mockProcessResults[1].isDuplicate,
        mockProcessResults[1].duplicateOfDocumentId
      );
    });

    it('should handle empty results array', async () => {
      const mockCollectionRequest = { realm_id: mockRealmId };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockCollectionRequest, error: null });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      (processCollectionRequestDocuments as any).mockResolvedValue([]);
      (updateRegisterForDocument as any).mockResolvedValue(undefined);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json).toEqual([]);
      expect(updateRegisterForDocument).not.toHaveBeenCalled();
    });
  });

  describe('Processing and Database Failures', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
      
      const mockCollectionRequest = { realm_id: mockRealmId };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockCollectionRequest, error: null });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);
    });

    it('should return 500 when processCollectionRequestDocuments throws', async () => {
      (processCollectionRequestDocuments as any).mockRejectedValue(new Error('Processing failed'));
      (updateRegisterForDocument as any).mockResolvedValue(undefined);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.error).toBe('Processing failed');
    });

    it('should return 404 when processCollectionRequestDocuments throws "not found" error', async () => {
      (processCollectionRequestDocuments as any).mockRejectedValue(new Error('Collection request not found'));
      (updateRegisterForDocument as any).mockResolvedValue(undefined);

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(404);
      expect(json.error).toBe('Collection request not found');
    });

    it('should return 500 when updateRegisterForDocument throws', async () => {
      const mockProcessResults = [
        {
          matchResult: {
            documentId: 'doc_1',
            qboTxnId: 'txn_1',
            confidence: 95,
            matchType: 'EXACT',
          },
          extractedFields: { amount: 100, date: '2023-01-15' },
          isDuplicate: false,
          duplicateOfDocumentId: null,
        },
      ];

      (processCollectionRequestDocuments as any).mockResolvedValue(mockProcessResults);
      (updateRegisterForDocument as any).mockRejectedValue(new Error('Database update failed'));

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.error).toBe('Database update failed');
    });

    it('should return 404 when updateRegisterForDocument throws "not found" error', async () => {
      const mockProcessResults = [
        {
          matchResult: {
            documentId: 'doc_1',
            qboTxnId: 'txn_1',
            confidence: 95,
            matchType: 'EXACT',
          },
          extractedFields: { amount: 100, date: '2023-01-15' },
          isDuplicate: false,
          duplicateOfDocumentId: null,
        },
      ];

      (processCollectionRequestDocuments as any).mockResolvedValue(mockProcessResults);
      (updateRegisterForDocument as any).mockRejectedValue(new Error('Document not found'));

      const params = { id: validCollectionRequestId };
      const mockRequest = createMockRequest(params);
      const response = await routeModule.POST(mockRequest, { params: Promise.resolve(params) });
      const json = await response.json();

      expect(response.status).toBe(404);
      expect(json.error).toBe('Document not found');
    });
  });
});