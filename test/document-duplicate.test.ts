import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: {} }));
import { hasStrongDuplicateMatch, type ExtractedDocumentFields } from '../lib/document-extraction';

const base: ExtractedDocumentFields = {
  vendorName: 'Acme Supplies', documentDate: '2026-10-01', totalAmount: 125.5,
  documentNumber: 'INV-123', documentType: 'invoice', rawText: '',
};

describe('evidence duplicate detection', () => {
  it('does not treat sparse common fields as a duplicate', () => {
    expect(hasStrongDuplicateMatch({ ...base, totalAmount: null, documentDate: null, documentNumber: null }, {
      extracted_vendor: 'Acme Supplies', extracted_amount: null, extracted_date: null, extracted_document_number: null,
    })).toBe(false);
  });

  it('requires three matching fields or a document number plus another matching field', () => {
    expect(hasStrongDuplicateMatch(base, {
      extracted_vendor: 'ACME SUPPLIES', extracted_amount: 125.5, extracted_date: '2026-10-01', extracted_document_number: null,
    })).toBe(true);
    expect(hasStrongDuplicateMatch({ ...base, totalAmount: null, documentDate: null, documentNumber: null }, {
      extracted_vendor: 'acme supplies', extracted_amount: null, extracted_date: null, extracted_document_number: 'INV-123',
    })).toBe(false);
    expect(hasStrongDuplicateMatch(base, {
      extracted_vendor: 'Acme Supplies', extracted_amount: 125.5, extracted_date: null, extracted_document_number: 'INV-123',
    })).toBe(true);
  });

  it('rejects a collision when any shared extracted field differs', () => {
    expect(hasStrongDuplicateMatch(base, {
      extracted_vendor: 'Acme Supplies', extracted_amount: 999, extracted_date: '2026-10-01', extracted_document_number: 'INV-123',
    })).toBe(false);
  });
});
