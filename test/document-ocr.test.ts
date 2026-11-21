import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetText = vi.fn();
const mockDestroy = vi.fn(async () => {});
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock('pdf-parse', () => ({
  PDFParse: class { getText(options?: unknown) { return mockGetText(options); } destroy() { return mockDestroy(); } },
}));

import { configureOcrEngine, configureOcrEngines, extractTextFromDocument } from '../lib/document-extraction';

afterEach(() => {
  configureOcrEngine(null);
  vi.clearAllMocks();
});

describe('configurable OCR extraction', () => {
  it('releases the PDF worker after successful text extraction', async () => {
    mockGetText.mockResolvedValue({ text: 'Readable invoice text' });
    await expect(extractTextFromDocument(Buffer.from('pdf'), 'application/pdf')).resolves.toBe('Readable invoice text');
    expect(mockDestroy).toHaveBeenCalledOnce();
  });
  it('sends images to the configured engine and returns its text', async () => {
    const recognize = vi.fn().mockResolvedValue('ACME RECEIPT TOTAL 12.00');
    configureOcrEngine({ recognize });
    const buffer = Buffer.from('image-bytes');
    await expect(extractTextFromDocument(buffer, 'image/png')).resolves.toBe('ACME RECEIPT TOTAL 12.00');
    expect(recognize).toHaveBeenCalledWith({ buffer, contentType: 'image/png' });
  });

  it('uses OCR for scanned PDFs with no embedded text', async () => {
    mockGetText.mockResolvedValue({ text: '  ' });
    const recognize = vi.fn().mockResolvedValue('Scanned invoice 55.00');
    configureOcrEngine({ recognize });
    const buffer = Buffer.from('scanned-pdf');
    await expect(extractTextFromDocument(buffer, 'application/pdf')).resolves.toBe('Scanned invoice 55.00');
    expect(recognize).toHaveBeenCalledWith({ buffer, contentType: 'application/pdf' });
  });

  it('does not treat parser-generated page-number footers as scanned document text', async () => {
    mockGetText.mockImplementation(async (options?: { pageJoiner?: string }) => ({
      text: options?.pageJoiner === '' ? '\n\n' : '\n\n-- 1 of 1 --\n\n',
    }));
    const recognize = vi.fn().mockResolvedValue('Scanned invoice ZV-2026-001 total 125.00');
    configureOcrEngine({ name: 'Tesseract', recognize });
    await expect(extractTextFromDocument(Buffer.from('scanned-pdf'), 'application/pdf'))
      .resolves.toBe('Scanned invoice ZV-2026-001 total 125.00');
    expect(mockGetText).toHaveBeenCalledWith({ pageJoiner: '' });
    expect(recognize).toHaveBeenCalledOnce();
  });
  it('falls back to OCR when embedded-text PDF parsing fails', async () => {
    mockGetText.mockRejectedValue(new Error('PDF parser failure'));
    const recognize = vi.fn().mockResolvedValue('Scanned bill 81.00');
    configureOcrEngine({ recognize });
    const buffer = Buffer.from('scan-pdf');

    await expect(extractTextFromDocument(buffer, 'application/pdf')).resolves.toBe('Scanned bill 81.00');
    expect(recognize).toHaveBeenCalledWith({ buffer, contentType: 'application/pdf' });
  });

  it('fails explicitly when OCR is unavailable for an image', async () => {
    await expect(extractTextFromDocument(Buffer.from('image'), 'image/jpeg')).rejects.toThrow('no OCR engine is configured');
  });

  it('fails explicitly when the engine returns no text', async () => {
    configureOcrEngine({ recognize: vi.fn().mockResolvedValue('   ') });
    await expect(extractTextFromDocument(Buffer.from('image'), 'image/jpeg')).rejects.toThrow('without readable text');
  });

  it('falls back through configured engines after errors or empty output', async () => {
    const first = vi.fn().mockRejectedValue(new Error('private provider detail'));
    const second = vi.fn().mockResolvedValue('   ');
    const third = vi.fn().mockResolvedValue('Scanned invoice 55.00');
    configureOcrEngines([
      { name: 'PaddleOCR', recognize: first },
      { name: 'docTR', recognize: second },
      { name: 'Tesseract', recognize: third },
    ]);

    await expect(extractTextFromDocument(Buffer.from('image'), 'image/jpeg')).resolves.toBe('Scanned invoice 55.00');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
  });

  it('reports reviewable OCR failure without leaking provider exception text', async () => {
    configureOcrEngines([
      { name: 'PaddleOCR', recognize: vi.fn().mockRejectedValue(new Error('PRIVATE DOCUMENT CONTENT')) },
      { name: 'docTR', recognize: vi.fn().mockResolvedValue(' ') },
      { name: 'Tesseract', recognize: vi.fn().mockRejectedValue(new Error('PRIVATE TOKEN')) },
    ]);

    const failure = extractTextFromDocument(Buffer.from('image'), 'image/jpeg');
    await expect(failure).rejects.toThrow('All configured OCR engines failed');
    await expect(failure).rejects.not.toThrow('PRIVATE');
  });
  it('keeps embedded PDF text extraction independent of OCR', async () => {
    mockGetText.mockResolvedValue({ text: 'Invoice total 19.00' });
    const recognize = vi.fn();
    configureOcrEngine({ recognize });
    await expect(extractTextFromDocument(Buffer.from('pdf'), 'application/pdf')).resolves.toBe('Invoice total 19.00');
    expect(recognize).not.toHaveBeenCalled();
  });
});
