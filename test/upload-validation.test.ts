import { describe, expect, it } from 'vitest';
import { MAX_EVIDENCE_UPLOAD_BYTES, validateEvidenceFile } from '../lib/upload-validation';

describe('evidence upload validation', () => {
  it('accepts a PDF whose content, MIME type, and extension agree', async () => {
    const file = new File(['%PDF-1.7 sample'], 'invoice.pdf', { type: 'application/pdf' });
    await expect(validateEvidenceFile(file)).resolves.toEqual({ valid: true, contentType: 'application/pdf' });
  });

  it('rejects MIME spoofing and mismatched extensions', async () => {
    const spoofed = new File(['%PDF-1.7 sample'], 'invoice.pdf', { type: 'image/png' });
    const wrongExtension = new File(['%PDF-1.7 sample'], 'invoice.png', { type: 'application/pdf' });
    await expect(validateEvidenceFile(spoofed)).resolves.toMatchObject({ valid: false });
    await expect(validateEvidenceFile(wrongExtension)).resolves.toMatchObject({ valid: false });
  });

  it('rejects unsupported file contents and oversize files', async () => {
    const unsupported = new File(['not a supported document'], 'payload.pdf', { type: 'application/pdf' });
    const oversized = new File([new Uint8Array(MAX_EVIDENCE_UPLOAD_BYTES + 1)], 'large.pdf', { type: 'application/pdf' });
    await expect(validateEvidenceFile(unsupported)).resolves.toMatchObject({ valid: false });
    await expect(validateEvidenceFile(oversized)).resolves.toMatchObject({ valid: false, error: 'File exceeds the 20 MB limit' });
  });
});
