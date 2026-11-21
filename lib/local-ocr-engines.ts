import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OcrEngine } from './document-extraction';

const execFile = promisify(execFileCallback);
const DEFAULT_ORDER = ['PaddleOCR', 'docTR', 'Tesseract'] as const;
const PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_MAX_BUFFER = 20 * 1024 * 1024;

type LocalOcrName = (typeof DEFAULT_ORDER)[number];
type ProcessRunner = (file: string, args: string[]) => Promise<string>;

interface LocalOcrOptions {
  env?: Record<string, string | undefined>;
  run?: ProcessRunner;
  cwd?: string;
  tempRoot?: string;
}

function runLocalProcess(file: string, args: string[]): Promise<string> {
  return execFile(file, args, {
    windowsHide: true,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: PROCESS_MAX_BUFFER,
    encoding: 'utf8',
  }).then(({ stdout }) => stdout);
}

function inputExtension(contentType: string): string {
  if (contentType === 'application/pdf') return '.pdf';
  const extensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/tiff': '.tif',
    'image/bmp': '.bmp',
    'image/webp': '.webp',
  };
  const extension = extensions[contentType.toLowerCase()];
  if (!extension) throw new Error('Unsupported local OCR content type');
  return extension;
}

async function withLocalInput<T>(
  input: { buffer: Buffer; contentType: string },
  options: LocalOcrOptions,
  callback: (directory: string, inputPath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), 'zevidt-ocr-'));
  try {
    const inputPath = path.join(directory, `document${inputExtension(input.contentType)}`);
    await writeFile(inputPath, input.buffer, { flag: 'wx' });
    return await callback(directory, inputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pythonCommand(env: Record<string, string | undefined>): { file: string; prefix: string[] } {
  const configured = env.ZEVIDT_OCR_PYTHON?.trim();
  if (configured) return { file: configured, prefix: [] };
  if (process.platform === 'win32') return { file: 'py', prefix: ['-3'] };
  return { file: 'python3', prefix: [] };
}

function workerPath(options: LocalOcrOptions): string {
  const configured = options.env?.ZEVIDT_OCR_WORKER_PATH?.trim();
  return configured || path.join(options.cwd ?? process.cwd(), 'scripts', 'ocr', 'zevidt_ocr_worker.py');
}

async function recognizeWithPython(
  engine: 'PaddleOCR' | 'docTR',
  input: { buffer: Buffer; contentType: string },
  options: LocalOcrOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const python = pythonCommand(env);
  return withLocalInput(input, options, async (_directory, inputPath) => {
    const args = [
      ...python.prefix,
      workerPath(options),
      '--engine',
      engine === 'PaddleOCR' ? 'paddleocr' : 'doctr',
      '--input',
      inputPath,
    ];
    return (await (options.run ?? runLocalProcess)(python.file, args)).trim();
  });
}

function sortPdfPages(files: string[], prefix: string): string[] {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pagePattern = new RegExp(`^${escapedPrefix}-(\\d+)\\.png$`, 'i');
  return files
    .map((file) => ({ file, match: pagePattern.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map((entry) => entry.file);
}

async function recognizeWithTesseract(
  input: { buffer: Buffer; contentType: string },
  options: LocalOcrOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const run = options.run ?? runLocalProcess;
  const executable = env.ZEVIDT_OCR_TESSERACT_EXECUTABLE?.trim() || (process.platform === 'win32' ? 'tesseract.exe' : 'tesseract');
  const language = env.ZEVIDT_OCR_TESSERACT_LANGUAGE?.trim() || 'eng';

  return withLocalInput(input, options, async (directory, inputPath) => {
    let imagePaths = [inputPath];
    if (input.contentType === 'application/pdf') {
      const pdfToPpm = env.ZEVIDT_OCR_PDFTOPPM_EXECUTABLE?.trim() || (process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm');
      const prefix = path.join(directory, 'page');
      await run(pdfToPpm, ['-png', '-r', '300', inputPath, prefix]);
      const pages = sortPdfPages(await readdir(directory), 'page');
      if (pages.length === 0) throw new Error('PDF rasterizer returned no pages');
      imagePaths = pages.map((page) => path.join(directory, page));
    }

    const pageText: string[] = [];
    for (const imagePath of imagePaths) {
      const text = await run(executable, [imagePath, 'stdout', '-l', language]);
      if (text.trim()) pageText.push(text.trim());
    }
    return pageText.join('\n\n');
  });
}

function createEngine(name: LocalOcrName, options: LocalOcrOptions): OcrEngine {
  return {
    name,
    recognize: (input) => {
      if (!input.contentType.startsWith('image/') && input.contentType !== 'application/pdf') {
        throw new Error('Local OCR supports PDF and image documents only');
      }
      if (name === 'Tesseract') return recognizeWithTesseract(input, options);
      return recognizeWithPython(name, input, options);
    },
  };
}

export function createLocalOcrEngines(options: LocalOcrOptions = {}): OcrEngine[] {
  const configuredOrder = options.env?.ZEVIDT_OCR_ORDER ?? process.env.ZEVIDT_OCR_ORDER;
  const requested = configuredOrder === undefined
    ? [...DEFAULT_ORDER]
    : configuredOrder.split(',').map((name) => name.trim()).filter(Boolean);

  const allowed = new Set<string>(DEFAULT_ORDER);
  if (requested.length === 0 || requested.some((name) => !allowed.has(name))) {
    throw new Error('ZEVIDT_OCR_ORDER must list PaddleOCR, docTR, and/or Tesseract');
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error('ZEVIDT_OCR_ORDER cannot contain duplicate engines');
  }

  return requested.map((name) => createEngine(name as LocalOcrName, options));
}
