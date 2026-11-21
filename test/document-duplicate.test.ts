import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn() }));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from, storage: { from: () => ({ download: mocks.download }) } } }));
import { checkForDuplicateDocument, hasStrongDuplicateMatch, type ExtractedDocumentFields } from '../lib/document-extraction';

const base: ExtractedDocumentFields = {
  vendorName: 'Acme Supplies', documentDate: '2026-10-01', totalAmount: 125.5,
  documentNumber: 'INV-123', documentType: 'invoice', rawText: '',
};

describe('evidence duplicate detection', () => {
  it.each([true, false])('requires actual byte identity even when all invoice fields agree: %s', async (identical) => {
    const candidate = { id: 'prior', storage_path: 'inbox/realm/prior.pdf', extracted_vendor: base.vendorName,
      extracted_amount: base.totalAmount, extracted_date: base.documentDate, extracted_document_number: base.documentNumber };
    const query: Record<string, any> = {};
    for (const method of ['select', 'eq', 'not']) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [candidate], error: null }).then(resolve);
    mocks.from.mockReturnValue(query);
    mocks.download.mockResolvedValue({ data: new Blob([identical ? 'invoice bytes' : 'delivery note bytes']), error: null });
    await expect(checkForDuplicateDocument('realm', base, 'current', Buffer.from('invoice bytes'))).resolves.toBe(identical ? 'prior' : null);
    expect(query.eq).toHaveBeenCalledWith('realm_id', 'realm');
  });
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
