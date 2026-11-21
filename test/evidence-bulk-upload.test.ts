import { describe, expect, it, vi } from 'vitest';
import { uploadEvidenceFiles } from '../lib/evidence-bulk-upload';

const files = (count: number) => Array.from({ length: count }, (_, i) => new File(['%PDF-fixture'], `document-${i}.pdf`, { type: 'application/pdf' }));
describe('public bulk evidence uploads', () => {
  it('accepts 76 files in one selection and retains every acknowledged document', async () => {
    let active = 0;
    const received: string[] = [];
    const submit = vi.fn(async (form: FormData) => {
      expect(++active).toBe(1);
      expect(form.getAll('files')).toHaveLength(1);
      const file = form.get('files') as File;
      await Promise.resolve(); active--;
      return Response.json({ documents: [{ id: file.name, filename: file.name }] }, { status: 201 });
    });
    const result = await uploadEvidenceFiles(files(76), submit, d => received.push(d.id), () => {});
    expect(result).toEqual({ uploaded: 76, rejected: [], uncertain: null, notSent: 0 });
    expect(new Set(received).size).toBe(76);
    expect(submit).toHaveBeenCalledTimes(76);
  });
  it('continues past a rejected file while preserving earlier success', async () => {
    let index = 0;
    const submit = vi.fn(async (form: FormData) => ++index === 2 ? new Response('', { status: 400 }) : Response.json({ documents: [{ id: String(index), filename: (form.get('files') as File).name }] }));
    const result = await uploadEvidenceFiles(files(3), submit, () => {}, () => {});
    expect(result.uploaded).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.uncertain).toBeNull();
  });
  it.each(['network', 'server', 'malformed'])('stops without retry after an ambiguous %s outcome', async (failure) => {
    const submit = vi.fn(async () => {
      if (failure === 'network') throw new Error('Connection lost after submission');
      return failure === 'server' ? new Response('', { status: 503 }) : Response.json({ documents: [] });
    });
    const result = await uploadEvidenceFiles(files(3), submit, () => {}, () => {});
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ uploaded: 0, uncertain: 'document-0.pdf', notSent: 2 });
  });
});
