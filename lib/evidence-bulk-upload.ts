export interface UploadedEvidenceDocument { id: string; filename: string }
export interface BulkUploadResult {
  uploaded: number;
  rejected: Array<{ filename: string; message: string }>;
  uncertain: string | null;
  notSent: number;
}

/** One selection, sequential requests; never blindly replay an ambiguous upload. */
export async function uploadEvidenceFiles<T extends UploadedEvidenceDocument>(
  files: File[],
  submit: (body: FormData) => Promise<Response>,
  onDocument: (document: T) => void,
  onProgress: (attempted: number, total: number) => void,
): Promise<BulkUploadResult> {
  const result: BulkUploadResult = { uploaded: 0, rejected: [], uncertain: null, notSent: 0 };
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    onProgress(index + 1, files.length);
    const body = new FormData();
    body.append('files', file);
    try {
      const response = await submit(body);
      if ([400, 404, 413, 415].includes(response.status)) {
        result.rejected.push({ filename: file.name, message: 'Not accepted. Check the file type, size, and upload link.' });
        continue;
      }
      if (!response.ok) throw new Error('Upload outcome requires reconciliation');
      const payload = await response.json();
      if (!Array.isArray(payload.documents) || payload.documents.length !== 1 ||
          typeof payload.documents[0]?.id !== 'string' || payload.documents[0]?.filename !== file.name) {
        throw new Error('Upload response could not be verified');
      }
      onDocument(payload.documents[0] as T);
      result.uploaded++;
    } catch {
      result.uncertain = file.name;
      result.notSent = files.length - index - 1;
      break;
    }
  }
  return result;
}
