export const MAX_EVIDENCE_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_EVIDENCE_UPLOAD_FILES = 10;

export type SupportedEvidenceMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export type EvidenceFileValidation =
  | { valid: true; contentType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' }
  | { valid: false; error: string };

export async function validateEvidenceFile(file: File): Promise<EvidenceFileValidation> {
  if (file.size === 0) return { valid: false, error: 'File is empty' };
  if (file.size > MAX_EVIDENCE_UPLOAD_BYTES) return { valid: false, error: 'File exceeds the 20 MB limit' };

  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let detected: SupportedEvidenceMime;
  if (Buffer.from(await file.slice(0, 1024).arrayBuffer()).toString('latin1').includes('%PDF-')) {
    detected = 'application/pdf';
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    detected = 'image/jpeg';
  } else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    detected = 'image/png';
  } else if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.slice(8, 12)).toString() === 'WEBP') {
    detected = 'image/webp';
  } else {
    return { valid: false, error: 'Unsupported or invalid file contents' };
  }

  const declared = file.type.toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== detected) {
    return { valid: false, error: 'Declared file type does not match file contents' };
  }

  const expectedExtension: Record<string, string[]> = {
    'application/pdf': ['.pdf'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
  };
  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  if (!expectedExtension[detected].includes(extension)) {
    return { valid: false, error: 'File extension does not match file contents' };
  }

  return { valid: true, contentType: detected };
}

export function safeEvidenceStorageFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
}
