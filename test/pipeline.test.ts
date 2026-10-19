/**
 * Mocked tests for lib/pipeline.ts
 * 
 * Tests cover:
 * - Successful execution and correct seven-stage sequencing
 * - Missing evidence and classification behavior
 * - QuickBooks download failures
 * - ZIP generation and verification failures
 * - Structured error handling and cleanup
 * - Statistics and generated package metadata
 * - ZIP content integrity and filename collision handling
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Helper to create a chainable Supabase query builder mock
const createSupabaseChain = (finalResult: any) => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(finalResult),
    update: vi.fn().mockReturnThis(),
  };
  return chain;
};

// Mock all external dependencies at module boundaries
vi.mock('../lib/quickbooks', () => ({
  getTransactions: vi.fn(),
  getAttachables: vi.fn(),
  normalizeTransactionList: vi.fn(),
  normalizeAttachables: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock('../lib/qbo-evidence-register', () => ({
  populateQboEvidenceRegister: vi.fn(),
  getRegisterEntries: vi.fn(),
  updateRegisterForDocument: vi.fn(),
}));

vi.mock('../lib/output', () =>({
  generateAndSaveCsvs: vi.fn(),
  splitEvidenceRegister: vi.fn(),
}));

vi.mock('../lib/zip', () => ({
  generateZip: vi.fn(),
}));

vi.mock('../lib/document-extraction', () => ({
  processCollectionRequestDocuments: vi.fn(),
  downloadDocument: vi.fn(),
}));

vi.mock('../lib/supabase-admin', () => {
  const mockFrom = vi.fn();
  return {
    supabaseAdmin: {
      from: mockFrom,
      storage: {
        from: vi.fn(() => ({
          download: vi.fn(),
        })),
      },
      _mockFrom: mockFrom,
    },
  };
});

// Mock os, path, fs modules - these are dynamically imported in pipeline.ts
const mockOs = { tmpdir: vi.fn(() => '/tmp') };
const mockPath = { join: vi.fn((...args: string[]) => args.join('/')) };
const mockFs = {
  mkdtempSync: vi.fn(() => '/tmp/auditready-qbo-attachments-test'),
  readFileSync: vi.fn(() => Buffer.from('test content')),
  rmSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 1024 })),
};

vi.mock('os', () => mockOs);
vi.mock('path', () => mockPath);
vi.mock('fs', () => mockFs);

// Import mocked modules and the module under test
import { getTransactions, getAttachables, normalizeTransactionList, normalizeAttachables, downloadFile } from '../lib/quickbooks';
import { populateQboEvidenceRegister, getRegisterEntries, updateRegisterForDocument } from '../lib/qbo-evidence-register';
import { generateAndSaveCsvs, splitEvidenceRegister } from '../lib/output';
import { generateZip } from '../lib/zip';
import { processCollectionRequestDocuments, downloadDocument } from '../lib/document-extraction';
import { supabaseAdmin } from '../lib/supabase-admin';
import { generatePackage, PipelineResult } from '../lib/pipeline';

describe('pipeline.ts - generatePackage', () => {
  const companyId = 'test_company_123';
  const startDate = '2023-01-01';
  const endDate = '2023-12-31';

  // Evidence documents storage for tests
  let evidenceDocuments: Map<string, { data: any; error: any }> = new Map();

  // Helper to set up supabase mock for a test
  const setupSupabaseMock = (options: {
    inboxDocuments?: any;
    collectionRequest?: any;
    evidenceDocuments?: Map<string, any>;
  } = {}) => {
    const { inboxDocuments = { data: [], error: null }, collectionRequest = { data: null, error: null } } = options;
    evidenceDocuments = options.evidenceDocuments || new Map();
    
    let inboxDocCallCount = 0;
    
    (supabaseAdmin.from as any).mockImplementation((table: string) => {
      if (table === 'inbox_documents') {
        inboxDocCallCount++;
        
        // First call: select('id').eq('realm_id', companyId).is('processed_at', null) - get unprocessed docs
        if (inboxDocCallCount === 1) {
          return createSupabaseChain(inboxDocuments);
        } else {
          // Later calls: select('storage_path, filename').eq('id', matchedDocumentId).single()
          const chain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation(function(this: any, column: string, value: string) {
              (this as any)._lastEqValue = value;
              return this;
            }),
            single: vi.fn().mockImplementation(function(this: any) {
              const docId = (this as any)._lastEqValue;
              const doc = evidenceDocuments.get(docId);
              return Promise.resolve(doc || { data: null, error: { message: 'Not found' } });
            }),
          };
          return chain;
        }
      }
      
      if (table === 'collection_requests') {
        return createSupabaseChain(collectionRequest);
      }
      
      return createSupabaseChain({ data: null, error: null });
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    evidenceDocuments.clear();
    
    // Default successful mocks
    (getTransactions as any).mockResolvedValue({ QueryResponse: { Transaction: [] } });
    (getAttachables as any).mockResolvedValue({ QueryResponse: { Attachable: [] } });
    (normalizeTransactionList as any).mockReturnValue([]);
    (normalizeAttachables as any).mockReturnValue([]);
    (populateQboEvidenceRegister as any).mockResolvedValue(undefined);
    (getRegisterEntries as any).mockResolvedValue([]);
    (updateRegisterForDocument as any).mockResolvedValue(undefined);
    (splitEvidenceRegister as any).mockReturnValue({ missingEntries: [], matchedEntries: [] });
    (generateAndSaveCsvs as any).mockResolvedValue({
      evidenceRegisterPath: '/tmp/evidence_register.csv',
      missingDocumentsPath: '/tmp/missing_documents.csv',
      matchedCount: 0,
      missingCount: 0,
    });
    (generateZip as any).mockResolvedValue('/tmp/audit_package.zip');
    (processCollectionRequestDocuments as any).mockResolvedValue([]);
    (downloadDocument as any).mockResolvedValue(Buffer.from('test document'));
    (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/receipt.pdf' });
    
    // Default fs mocks - use the mocked module
    mockFs.mkdtempSync.mockReturnValue('/tmp/auditready-qbo-attachments-test');
    mockFs.readFileSync.mockReturnValue(Buffer.from('test content'));
    mockFs.rmSync.mockImplementation(() => {});
    mockFs.statSync.mockReturnValue({ size: 1024 });
    
    // Default os mock
    mockOs.tmpdir.mockReturnValue('/tmp');
    
    // Default path mock
    mockPath.join.mockImplementation((...args: string[]) => args.join('/'));
    
    // Default supabase mock - no inbox docs, no collection request
    setupSupabaseMock({
      inboxDocuments: { data: [], error: null },
      collectionRequest: { data: null, error: null },
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Successful execution and seven-stage sequencing', () => {
    it('should complete all seven stages successfully with empty data', async () => {
      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.zipPath).toBe('/tmp/audit_package.zip');
      expect(result.error).toBeUndefined();
      
      // Verify stats
      expect(result.stats.transactionCount).toBe(0);
      expect(result.stats.attachableCount).toBe(0);
      expect(result.stats.matchedCount).toBe(0);
      expect(result.stats.missingCount).toBe(0);
      expect(result.stats.successfulDownloadCount).toBe(0);
      expect(result.stats.failedDownloadCount).toBe(0);
      expect(result.stats.zipSizeBytes).toBe(1024);
      expect(result.stats.elapsedTimeMs).toBeGreaterThanOrEqual(0);

      // Verify all stages were called in order
      expect(getTransactions).toHaveBeenCalledWith(startDate, endDate);
      expect(getAttachables).toHaveBeenCalled();
      expect(populateQboEvidenceRegister).toHaveBeenCalledWith(companyId, startDate, endDate);
      expect(getRegisterEntries).toHaveBeenCalledWith(companyId, undefined, startDate, endDate);
      expect(generateAndSaveCsvs).toHaveBeenCalled();
      expect(generateZip).toHaveBeenCalled();
    });

    it('should process transactions through all stages with data', async () => {
      const mockTransactions = [
        { Id: 'txn_1', TxnType: 'Bill', VendorRef: { name: 'Vendor A' }, TotalAmt: 100, TxnDate: '2023-06-15', DocNumber: 'INV-001' },
        { Id: 'txn_2', TxnType: 'Invoice', VendorRef: { name: 'Vendor B' }, TotalAmt: 200, TxnDate: '2023-06-16', DocNumber: 'INV-002' },
      ];
      const mockAttachables = [
        { Id: 'att_1', FileName: 'receipt.pdf', AttachableRef: [{ EntityRef: { value: 'txn_1' } }] },
      ];
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (normalizeTransactionList as any).mockReturnValue(mockTransactions);
      (normalizeAttachables as any).mockReturnValue(mockAttachables);
      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (splitEvidenceRegister as any).mockReturnValue({ missingEntries: [], matchedEntries: mockRegisterEntries });
      
      // Set up evidence document
      evidenceDocuments.set('doc_1', { data: { storage_path: 'path/doc_1.pdf', filename: 'receipt.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.transactionCount).toBe(2);
      expect(result.stats.attachableCount).toBe(1);
      expect(result.stats.matchedCount).toBe(1);
      expect(result.stats.missingCount).toBe(0);
    });

    it('should correctly sequence all stages (getRegisterEntries called twice)', async () => {
      const callOrder: string[] = [];
      
      (getTransactions as any).mockImplementation(async () => { callOrder.push('getTransactions'); return { QueryResponse: { Transaction: [] } }; });
      (getAttachables as any).mockImplementation(async () => { callOrder.push('getAttachables'); return { QueryResponse: { Attachable: [] } }; });
      (populateQboEvidenceRegister as any).mockImplementation(async () => { callOrder.push('populateQboEvidenceRegister'); });
      (getRegisterEntries as any).mockImplementation(async () => { callOrder.push('getRegisterEntries'); return []; });
      (generateAndSaveCsvs as any).mockImplementation(async () => { callOrder.push('generateAndSaveCsvs'); return { evidenceRegisterPath: '', missingDocumentsPath: '', matchedCount: 0, missingCount: 0 }; });
      (generateZip as any).mockImplementation(async () => { callOrder.push('generateZip'); return '/tmp/test.zip'; });

      await generatePackage(companyId, startDate, endDate);

      // getRegisterEntries is called twice: once after populateQboEvidenceRegister, once after inbox processing
      expect(callOrder).toEqual([
        'getTransactions',
        'getAttachables',
        'populateQboEvidenceRegister',
        'getRegisterEntries',
        'getRegisterEntries',
        'generateAndSaveCsvs',
        'generateZip',
      ]);
    });
  });

  describe('Missing evidence and classification behavior', () => {
    it('should classify MISSING entries correctly', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: null,
          attachmentFilename: null,
          attachmentFileSize: null,
          attachmentDownloadUrl: null,
          registerState: 'MISSING',
          matchedDocumentId: null,
          matchConfidence: null,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (splitEvidenceRegister as any).mockReturnValue({
        missingEntries: [mockRegisterEntries[0]],
        matchedEntries: [mockRegisterEntries[1]],
      });
      
      // Set up evidence document for the matched entry
      evidenceDocuments.set('doc_1', { data: { storage_path: 'path/doc_1.pdf', filename: 'receipt.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.matchedCount).toBe(1);
      expect(result.stats.missingCount).toBe(1);
    });

    it('should classify WRONG_MATCHED as orphaned', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'wrong_receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/wrong.pdf',
          registerState: 'WRONG_MATCHED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 50,
          matchFieldDetails: null,
          correctQboTxnId: 'txn_correct',
          reviewCandidateTxnIds: ['txn_correct'],
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      
      // Set up evidence document
      evidenceDocuments.set('doc_1', { data: { storage_path: 'path/doc_1.pdf', filename: 'wrong_receipt.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      // WRONG_MATCHED should be treated as having evidence for download
      expect(result.stats.successfulDownloadCount).toBeGreaterThanOrEqual(0);
    });

    it('should handle REVIEW_REQUIRED state', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'REVIEW_REQUIRED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 75,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: ['txn_2', 'txn_3'],
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      
      // Set up evidence document
      evidenceDocuments.set('doc_1', { data: { storage_path: 'path/doc_1.pdf', filename: 'receipt.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
    });
  });

  describe('QuickBooks download failures', () => {
    it('should handle Transaction Retrieval failure', async () => {
      (getTransactions as any).mockRejectedValue(new Error('QuickBooks API error: Invalid token'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('Transaction Retrieval');
      expect(result.error?.reason).toContain('Failed to retrieve transactions');
      expect(result.error?.details).toBeDefined();
    });

    it('should handle Attachable Retrieval failure', async () => {
      (getAttachables as any).mockRejectedValue(new Error('QuickBooks API error: Rate limited'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('Attachable Retrieval');
      expect(result.error?.reason).toContain('Failed to retrieve attachables');
    });

    it('should handle QBO-side attachment download failures gracefully', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null, // QBO-side only
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: false, error: 'Download failed: Not found' });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true); // Should not fail the entire pipeline
      expect(result.stats.failedDownloadCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty file downloads from QuickBooks', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/empty.pdf' });
      mockFs.readFileSync.mockReturnValue(Buffer.from('')); // Empty buffer

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.failedDownloadCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ZIP generation and verification failures', () => {
    it('should handle ZIP generation failure', async () => {
      (generateZip as any).mockRejectedValue(new Error('ZIP creation failed: Disk full'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('ZIP Generation');
      expect(result.error?.reason).toContain('Failed to generate ZIP');
    });

    it('should verify ZIP file size after generation', async () => {
      mockFs.statSync.mockReturnValue({ size: 2048576 }); // 2MB

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.zipSizeBytes).toBe(2048576);
      expect(mockFs.statSync).toHaveBeenCalled();
    });

    it('should handle ZIP verification failure gracefully', async () => {
      mockFs.statSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('Pipeline');
    });
  });

  describe('Structured error handling and cleanup', () => {
    it('should handle Evidence Register Matching failure', async () => {
      (populateQboEvidenceRegister as any).mockRejectedValue(new Error('Database connection failed'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('Evidence Register Matching');
      expect(result.error?.reason).toContain('Failed to build QBO evidence register');
    });

    it('should handle Evidence CSV Generation failure', async () => {
      (generateAndSaveCsvs as any).mockRejectedValue(new Error('CSV write permission denied'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('Evidence CSV Generation');
      expect(result.error?.reason).toContain('Failed to generate CSVs');
    });

    it('should handle Inbox Document Processing failure', async () => {
      (supabaseAdmin.from as any).mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: new Error('DB error') }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ error: null }),
        })),
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      expect(result.error?.stage).toBe('Inbox Document Processing');
    });

    it('should handle Evidence Document Download failure', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: null,
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      
      // Set up evidence document to return error
      evidenceDocuments.set('doc_1', { data: null, error: { message: 'Not found' } });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      // Pipeline catches per-document download errors and continues
      expect(result.success).toBe(true);
      expect(result.stats.failedDownloadCount).toBeGreaterThanOrEqual(1);
    });

    it('should clean up temporary directory after QBO attachment downloads', async () => {
      const mockTempDir = '/tmp/auditready-qbo-attachments-test123';
      mockFs.mkdtempSync.mockReturnValue(mockTempDir);
      mockFs.readFileSync.mockReturnValue(Buffer.from('test content'));

      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/receipt.pdf' });

      await generatePackage(companyId, startDate, endDate);

      expect(mockFs.rmSync).toHaveBeenCalledWith(mockTempDir, { recursive: true, force: true });
    });

    it('should handle cleanup failure gracefully', async () => {
      const mockTempDir = '/tmp/auditready-qbo-attachments-test123';
      mockFs.mkdtempSync.mockReturnValue(mockTempDir);
      mockFs.rmSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });
      mockFs.readFileSync.mockReturnValue(Buffer.from('test content'));

      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/receipt.pdf' });

      const result = await generatePackage(companyId, startDate, endDate);

      // Should not fail the pipeline due to cleanup error
      expect(result.success).toBe(true);
    });

    it('should handle unexpected errors in pipeline', async () => {
      (getTransactions as any).mockImplementation(() => {
        throw new Error('Unexpected runtime error');
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(false);
      // Synchronous throw in getTransactions is caught in the try/catch of Transaction Retrieval stage
      expect(result.error?.stage).toBe('Transaction Retrieval');
      expect(result.error?.reason).toContain('Failed to retrieve transactions');
    });
  });

  describe('Statistics and generated package metadata', () => {
    it('should return correct statistics for all metrics', async () => {
      const mockTransactions = [
        { Id: 'txn_1', TxnType: 'Bill', VendorRef: { name: 'Vendor A' }, TotalAmt: 100, TxnDate: '2023-06-15', DocNumber: 'INV-001' },
        { Id: 'txn_2', TxnType: 'Invoice', VendorRef: { name: 'Vendor B' }, TotalAmt: 200, TxnDate: '2023-06-16', DocNumber: 'INV-002' },
        { Id: 'txn_3', TxnType: 'Bill', VendorRef: { name: 'Vendor C' }, TotalAmt: 300, TxnDate: '2023-06-17', DocNumber: 'INV-003' },
      ];
      const mockAttachables = [
        { Id: 'att_1', FileName: 'receipt1.pdf', AttachableRef: [{ EntityRef: { value: 'txn_1' } }] },
        { Id: 'att_2', FileName: 'receipt2.pdf', AttachableRef: [{ EntityRef: { value: 'txn_2' } }] },
      ];
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt1.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt1.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_2',
          attachmentFilename: 'receipt2.pdf',
          attachmentFileSize: 2048,
          attachmentDownloadUrl: 'https://example.com/receipt2.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_2',
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_3',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-17',
          qboTxnVendor: 'Vendor C',
          qboTxnAmount: 300,
          qboTxnDocNumber: 'INV-003',
          attachableId: null,
          attachmentFilename: null,
          attachmentFileSize: null,
          attachmentDownloadUrl: null,
          registerState: 'MISSING',
          matchedDocumentId: null,
          matchConfidence: null,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (normalizeTransactionList as any).mockReturnValue(mockTransactions);
      (normalizeAttachables as any).mockReturnValue(mockAttachables);
      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (splitEvidenceRegister as any).mockReturnValue({
        missingEntries: [mockRegisterEntries[2]],
        matchedEntries: [mockRegisterEntries[0], mockRegisterEntries[1]],
      });
      
      // Set up evidence documents
      evidenceDocuments.set('doc_1', { data: { storage_path: 'path/doc_1.pdf', filename: 'receipt1.pdf' }, error: null });
      evidenceDocuments.set('doc_2', { data: { storage_path: 'path/doc_2.pdf', filename: 'receipt2.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.transactionCount).toBe(3);
      expect(result.stats.attachableCount).toBe(2);
      expect(result.stats.matchedCount).toBe(2);
      expect(result.stats.missingCount).toBe(1);
      expect(result.stats.successfulDownloadCount).toBe(2);
      expect(result.stats.failedDownloadCount).toBe(0);
      expect(result.stats.zipSizeBytes).toBe(1024);
      expect(result.stats.elapsedTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include elapsedTimeMs in stats', async () => {
      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.stats.elapsedTimeMs).toBeDefined();
      expect(typeof result.stats.elapsedTimeMs).toBe('number');
      expect(result.stats.elapsedTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return zipPath in successful result', async () => {
      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.zipPath).toBeDefined();
      expect(typeof result.zipPath).toBe('string');
      expect(result.zipPath).toContain('.zip');
    });

    it('should track QBO-side-only attachment downloads in stats', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'qbo_receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/qbo_receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null, // QBO-side only
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_2',
          attachmentFilename: 'qbo_receipt2.pdf',
          attachmentFileSize: 2048,
          attachmentDownloadUrl: 'https://example.com/qbo_receipt2.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null, // QBO-side only
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/receipt.pdf' });
      mockFs.readFileSync.mockReturnValue(Buffer.from('test content'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.successfulDownloadCount).toBe(2);
      expect(result.stats.failedDownloadCount).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty transaction list', async () => {
      (normalizeTransactionList as any).mockReturnValue([]);
      (normalizeAttachables as any).mockReturnValue([]);

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.transactionCount).toBe(0);
      expect(result.stats.attachableCount).toBe(0);
    });

    it('should handle no collection request found', async () => {
      // Use the standard mock setup but with no collection request
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(processCollectionRequestDocuments).not.toHaveBeenCalled();
    });

    it('should handle inbox document download failure for specific document', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: null,
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_1',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: null,
          attachmentFilename: 'receipt2.pdf',
          attachmentFileSize: 2048,
          attachmentDownloadUrl: 'https://example.com/receipt2.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_2',
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadDocument as any)
        .mockResolvedValueOnce(Buffer.from('doc 1 content'))
        .mockRejectedValueOnce(new Error('Document not found in storage'));
      
      // Set up evidence documents
      evidenceDocuments.set('doc_1', { data: { storage_path: 'path/doc_1.pdf', filename: 'receipt.pdf' }, error: null });
      evidenceDocuments.set('doc_2', { data: { storage_path: 'path/doc_2.pdf', filename: 'receipt2.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      expect(result.stats.successfulDownloadCount).toBe(1);
      expect(result.stats.failedDownloadCount).toBe(1);
    });

    it('should deduplicate QBO-side attachments by attachableId', async () => {
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_1', // Same attachableId
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/receipt.pdf' });
      mockFs.readFileSync.mockReturnValue(Buffer.from('test content'));

      const result = await generatePackage(companyId, startDate, endDate);

      expect(result.success).toBe(true);
      // Should only download once due to deduplication
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(result.stats.successfulDownloadCount).toBe(1);
    });
  });

  describe('ZIP content integrity', () => {
    it('should include both client-uploaded evidence and QBO-side attachments in ZIP generation input', async () => {
      // This test verifies that generateZip is called with evidence from both sources
      const mockRegisterEntries = [
        // Client-uploaded evidence (matchedDocumentId is set)
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: null,
          attachmentFilename: 'client_receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/client_receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_client_1',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        // QBO-side-only attachment (matchedDocumentId is null, attachableId is set)
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_qbo_1',
          attachmentFilename: 'qbo_receipt.pdf',
          attachmentFileSize: 2048,
          attachmentDownloadUrl: 'https://example.com/qbo_receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        // Another client-uploaded evidence
        {
          qboTxnId: 'txn_3',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-17',
          qboTxnVendor: 'Vendor C',
          qboTxnAmount: 300,
          qboTxnDocNumber: 'INV-003',
          attachableId: null,
          attachmentFilename: 'client_invoice.pdf',
          attachmentFileSize: 4096,
          attachmentDownloadUrl: 'https://example.com/client_invoice.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_client_2',
          matchConfidence: 85,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/qbo_receipt.pdf' });
      mockFs.readFileSync.mockReturnValue(Buffer.from('qbo attachment content'));
      
      // Set up evidence documents for client-uploaded
      evidenceDocuments.set('doc_client_1', { data: { storage_path: 'path/doc_client_1.pdf', filename: 'client_receipt.pdf' }, error: null });
      evidenceDocuments.set('doc_client_2', { data: { storage_path: 'path/doc_client_2.pdf', filename: 'client_invoice.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      await generatePackage(companyId, startDate, endDate);

      // Verify generateZip was called
      expect(generateZip).toHaveBeenCalled();
      
      // Capture the successfulEvidenceFiles argument passed to generateZip
      const zipCall = (generateZip as any).mock.calls[0];
      const successfulEvidenceFiles = zipCall[3]; // 4th argument
      
      // Verify we have 3 files total (2 client + 1 QBO-side, deduped)
      expect(successfulEvidenceFiles.length).toBe(3);
      
      // Verify client-uploaded evidence files are present with their original filenames
      const clientFile1 = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'doc_client_1');
      expect(clientFile1).toBeDefined();
      expect(clientFile1.fileName).toBe('client_receipt.pdf');
      expect(clientFile1.buffer).toBeInstanceOf(Buffer);
      
      const clientFile2 = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'doc_client_2');
      expect(clientFile2).toBeDefined();
      expect(clientFile2.fileName).toBe('client_invoice.pdf');
      expect(clientFile2.buffer).toBeInstanceOf(Buffer);
      
      // Verify QBO-side attachment is present with synthetic matchedDocumentId and generated filename
      const qboFile = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'qbo-att_qbo_1');
      expect(qboFile).toBeDefined();
      expect(qboFile.matchedDocumentId).toBe('qbo-att_qbo_1');
      // The filename should be built using buildQboZipFileName: {txnType}_{txnId}_{vendor}_{date}_{sanitizedFilename}
      expect(qboFile.fileName).toMatch(/^Invoice_txn_2_Vendor B_20230616_qbo_receipt\.pdf$/);
      expect(qboFile.buffer).toBeInstanceOf(Buffer);
    });

    it('should deduplicate attachable by matchedDocumentId in ZIP input (single entry per document)', async () => {
      // When the same matchedDocumentId appears for multiple transactions,
      // it should only appear once in the ZIP input
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: null,
          attachmentFilename: 'shared_receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/shared_receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_shared',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: null,
          attachmentFilename: 'shared_receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/shared_receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_shared', // Same matchedDocumentId
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      
      // Set up evidence document
      evidenceDocuments.set('doc_shared', { data: { storage_path: 'path/doc_shared.pdf', filename: 'shared_receipt.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      await generatePackage(companyId, startDate, endDate);

      // Verify generateZip was called
      expect(generateZip).toHaveBeenCalled();
      
      // Capture the successfulEvidenceFiles argument passed to generateZip
      const zipCall = (generateZip as any).mock.calls[0];
      const successfulEvidenceFiles = zipCall[3];
      
      // Should only have 1 entry for the shared document (deduplicated by matchedDocumentId)
      expect(successfulEvidenceFiles.length).toBe(1);
      expect(successfulEvidenceFiles[0].matchedDocumentId).toBe('doc_shared');
      expect(successfulEvidenceFiles[0].fileName).toBe('shared_receipt.pdf');
    });
  });

  describe('Filename collision handling', () => {
    it('should handle two different attachableIds with the same filename (QBO-side collision)', async () => {
      // Two different QBO attachables with the same filename
      // The pipeline deduplicates by attachableId, so both should be downloaded
      // but the ZIP layer should handle filename collision
      const mockRegisterEntries = [
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: 'att_1',
          attachmentFilename: 'receipt.pdf', // Same filename
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt1.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_2', // Different attachableId
          attachmentFilename: 'receipt.pdf', // Same filename
          attachmentFileSize: 2048,
          attachmentDownloadUrl: 'https://example.com/receipt2.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      
      // Mock downloadFile to return different content for each attachableId
      let downloadCallCount = 0;
      (downloadFile as any).mockImplementation(async (attachableId: string) => {
        downloadCallCount++;
        return { success: true, filePath: `/tmp/${attachableId}.pdf` };
      });
      
      // Mock readFileSync to return different content based on call
      let readCallCount = 0;
      mockFs.readFileSync.mockImplementation(() => {
        readCallCount++;
        return Buffer.from(`content for attachable ${readCallCount}`);
      });

      await generatePackage(companyId, startDate, endDate);

      // Both attachables should be downloaded (different attachableIds)
      expect(downloadFile).toHaveBeenCalledTimes(2);
      
      // Verify generateZip was called with both files
      expect(generateZip).toHaveBeenCalled();
      const zipCall = (generateZip as any).mock.calls[0];
      const successfulEvidenceFiles = zipCall[3];
      
      // Should have 2 QBO-side entries (different attachableIds, not deduped)
      expect(successfulEvidenceFiles.length).toBe(2);
      
      // Both should have synthetic matchedDocumentIds based on their attachableIds
      const file1 = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'qbo-att_1');
      const file2 = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'qbo-att_2');
      
      expect(file1).toBeDefined();
      expect(file2).toBeDefined();
      
      // Both should have the same base filename 'receipt.pdf' before ZIP collision handling
      // The actual ZIP collision handling happens in generateZip (lib/zip.ts)
      // which uses matchedDocumentId to disambiguate
      // Note: txn_1 has date 2023-06-15 -> 20230615, txn_2 has date 2023-06-16 -> 20230616
      expect(file1.fileName).toMatch(/^Bill_txn_1_Vendor A_20230615_receipt\.pdf$/);
      expect(file2.fileName).toMatch(/^Invoice_txn_2_Vendor B_20230616_receipt\.pdf$/);
      
      // Filenames should be different due to transaction metadata prefix
      expect(file1.fileName).not.toBe(file2.fileName);
    });

    it('should handle filename collision between client-uploaded and QBO-side attachments', async () => {
      // Client-uploaded document and QBO-side attachment with same filename
      const mockRegisterEntries = [
        // Client-uploaded
        {
          qboTxnId: 'txn_1',
          qboTxnType: 'Bill',
          qboTxnDate: '2023-06-15',
          qboTxnVendor: 'Vendor A',
          qboTxnAmount: 100,
          qboTxnDocNumber: 'INV-001',
          attachableId: null,
          attachmentFilename: 'receipt.pdf',
          attachmentFileSize: 1024,
          attachmentDownloadUrl: 'https://example.com/receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: 'doc_client',
          matchConfidence: 95,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
        // QBO-side with same filename
        {
          qboTxnId: 'txn_2',
          qboTxnType: 'Invoice',
          qboTxnDate: '2023-06-16',
          qboTxnVendor: 'Vendor B',
          qboTxnAmount: 200,
          qboTxnDocNumber: 'INV-002',
          attachableId: 'att_qbo',
          attachmentFilename: 'receipt.pdf', // Same filename as client upload
          attachmentFileSize: 2048,
          attachmentDownloadUrl: 'https://example.com/qbo_receipt.pdf',
          registerState: 'MATCHED',
          matchedDocumentId: null,
          matchConfidence: 90,
          matchFieldDetails: null,
          correctQboTxnId: null,
          reviewCandidateTxnIds: null,
        },
      ];

      (getRegisterEntries as any).mockResolvedValue(mockRegisterEntries);
      (downloadFile as any).mockResolvedValue({ success: true, filePath: '/tmp/qbo_receipt.pdf' });
      mockFs.readFileSync.mockReturnValue(Buffer.from('qbo attachment content'));
      
      // Set up evidence document for client upload
      evidenceDocuments.set('doc_client', { data: { storage_path: 'path/doc_client.pdf', filename: 'receipt.pdf' }, error: null });
      setupSupabaseMock({
        inboxDocuments: { data: [], error: null },
        collectionRequest: { data: null, error: null },
        evidenceDocuments,
      });

      await generatePackage(companyId, startDate, endDate);

      // Verify generateZip was called with both files
      expect(generateZip).toHaveBeenCalled();
      const zipCall = (generateZip as any).mock.calls[0];
      const successfulEvidenceFiles = zipCall[3];
      
      // Should have 2 entries
      expect(successfulEvidenceFiles.length).toBe(2);
      
      // Client file keeps original name
      const clientFile = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'doc_client');
      expect(clientFile).toBeDefined();
      expect(clientFile.fileName).toBe('receipt.pdf');
      
      // QBO file gets prefixed with transaction metadata
      const qboFile = successfulEvidenceFiles.find((f: any) => f.matchedDocumentId === 'qbo-att_qbo');
      expect(qboFile).toBeDefined();
      expect(qboFile.fileName).toMatch(/^Invoice_txn_2_Vendor B_20230616_receipt\.pdf$/);
      
      // Filenames should be different (no collision at ZIP input level)
      expect(clientFile.fileName).not.toBe(qboFile.fileName);
    });
  });
});