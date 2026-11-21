import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalOcrEngines } from '../lib/local-ocr-engines';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zevidt-ocr-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('local OCR engine adapters', () => {
  it('uses PaddleOCR, docTR, then Tesseract by default', () => {
    expect(createLocalOcrEngines().map((engine) => engine.name)).toEqual(['PaddleOCR', 'docTR', 'Tesseract']);
  });

  it('accepts an explicit fallback order and rejects unknown or repeated engines', () => {
    expect(createLocalOcrEngines({ env: { ZEVIDT_OCR_ORDER: 'Tesseract,PaddleOCR' } }).map((engine) => engine.name))
      .toEqual(['Tesseract', 'PaddleOCR']);
    expect(() => createLocalOcrEngines({ env: { ZEVIDT_OCR_ORDER: 'CloudOCR' } })).toThrow('ZEVIDT_OCR_ORDER');
    expect(() => createLocalOcrEngines({ env: { ZEVIDT_OCR_ORDER: 'docTR,docTR' } })).toThrow('duplicate');
  });

  it('passes an image through the Tesseract executable and removes its temporary copy', async () => {
    const tempRoot = await createTempRoot();
    let copiedInput = '';
    const run = vi.fn(async (_file: string, args: string[]) => {
      copiedInput = args[0];
      expect((await readFile(copiedInput)).toString()).toBe('private image bytes');
      return 'Receipt total 21.00';
    });
    const engine = createLocalOcrEngines({
      env: { ZEVIDT_OCR_ORDER: 'Tesseract', ZEVIDT_OCR_TESSERACT_EXECUTABLE: 'tesseract-test.exe' },
      run,
      tempRoot,
    })[0];

    await expect(engine.recognize({ buffer: Buffer.from('private image bytes'), contentType: 'image/png' }))
      .resolves.toBe('Receipt total 21.00');
    expect(run).toHaveBeenCalledWith('tesseract-test.exe', [expect.stringMatching(/document\.png$/), 'stdout', '-l', 'eng']);
    await expect(stat(copiedInput)).rejects.toThrow();
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('rasterizes each scanned PDF page and OCRs in page order', async () => {
    const tempRoot = await createTempRoot();
    const calls: string[] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      calls.push(file);
      if (file === 'pdftoppm-test.exe') {
        const prefix = args[args.length - 1];
        await writeFile(`${prefix}-2.png`, 'page two');
        await writeFile(`${prefix}-1.png`, 'page one');
        return '';
      }
      return args[0].endsWith('page-1.png') ? 'First page' : 'Second page';
    });
    const engine = createLocalOcrEngines({
      env: {
        ZEVIDT_OCR_ORDER: 'Tesseract',
        ZEVIDT_OCR_TESSERACT_EXECUTABLE: 'tesseract-test.exe',
        ZEVIDT_OCR_PDFTOPPM_EXECUTABLE: 'pdftoppm-test.exe',
      },
      run,
      tempRoot,
    })[0];

    await expect(engine.recognize({ buffer: Buffer.from('%PDF fake bytes'), contentType: 'application/pdf' }))
      .resolves.toBe('First page\n\nSecond page');
    expect(calls).toEqual(['pdftoppm-test.exe', 'tesseract-test.exe', 'tesseract-test.exe']);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('invokes the Python worker with a local temporary file for PaddleOCR', async () => {
    const tempRoot = await createTempRoot();
    const run = vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe('python-test.exe');
      expect(args).toContain('--engine');
      expect(args).toContain('paddleocr');
      const inputPath = args[args.indexOf('--input') + 1];
      expect((await readFile(inputPath)).toString()).toBe('local PDF bytes');
      return 'Invoice 42.00';
    });
    const engine = createLocalOcrEngines({
      env: { ZEVIDT_OCR_ORDER: 'PaddleOCR', ZEVIDT_OCR_PYTHON: 'python-test.exe' },
      run,
      cwd: 'C:\\zevidt',
      tempRoot,
    })[0];

    await expect(engine.recognize({ buffer: Buffer.from('local PDF bytes'), contentType: 'application/pdf' }))
      .resolves.toBe('Invoice 42.00');
    expect(run).toHaveBeenCalledOnce();
    expect(await readdir(tempRoot)).toEqual([]);
  });
});
