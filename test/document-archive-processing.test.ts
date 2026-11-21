import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  download: vi.fn(),
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
}));

vi.mock('../lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: mocks.from,
    storage: { from: vi.fn(() => ({ download: mocks.download })) },
  },
}));
vi.mock('pdf-parse', () => ({ PDFParse: class {
  async getText() { return { text: 'Invoice number 123\nTotal: $20.00' }; }
  async destroy() {}
} }));
vi.mock('../lib/local-ocr-engines', () => ({ createLocalOcrEngines: vi.fn(() => []) }));

import { getClaimedTransactionIds, getCollectionRequestWithTransactions, processCollectionRequestDocuments, processInboxDocument } from '../lib/document-extraction';

function makeQuery(table: string) {
  type MockQuery = {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    is: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
  };
  const query = {} as MockQuery;
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    mocks.filters.push({ table, column, value });
    return query;
  });
  query.is = vi.fn((column: string, value: unknown) => {
    mocks.filters.push({ table, column, value });
    return query;
  });
  query.single = vi.fn(async () => table === 'collection_requests'
    ? { data: { realm_id: 'realm-1' }, error: null }
    : { data: null, error: { message: 'Archived document is excluded' } });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  return query;
}

describe('archived inbox document processing boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filters.length = 0;
    mocks.from.mockImplementation((table: string) => makeQuery(table));
  });

  it('does not select archived documents for collection-wide processing', async () => {
    await processCollectionRequestDocuments('request-1');

    expect(mocks.filters).toContainEqual({ table: 'inbox_documents', column: 'archived_at', value: null });
    expect(mocks.filters).toContainEqual({ table: 'inbox_documents', column: 'processed_at', value: null });
  });

  it('does not treat a failed collection query as a missing request', async () => {
    const query = makeQuery('collection_requests');
    query.single.mockResolvedValue({ data: null, error: { message: 'PRIVATE_DB_ERROR' } });
    mocks.from.mockReturnValue(query);
    await expect(getCollectionRequestWithTransactions('request-1'))
      .rejects.toThrow('Could not load the collection request for document matching');
  });

  it('does not treat a failed register lookup as no matching transactions', async () => {
    const requestQuery = makeQuery('collection_requests');
    requestQuery.single.mockResolvedValue({
      data: { id: 'request-1', realm_id: 'realm-1', transaction_ids: ['txn-1'] }, error: null,
    });
    const registerQuery = {
      select: vi.fn(), eq: vi.fn(), in: vi.fn(), neq: vi.fn(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'PRIVATE_DB_ERROR' } }).then(resolve),
    };
    for (const method of [registerQuery.select, registerQuery.eq, registerQuery.in, registerQuery.neq]) {
      method.mockReturnValue(registerQuery);
    }
    mocks.from.mockReset().mockReturnValueOnce(requestQuery).mockReturnValueOnce(registerQuery);

    await expect(getCollectionRequestWithTransactions('request-1'))
      .rejects.toThrow(/^Could not load transaction data for document matching$/);
    expect(registerQuery.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
    expect(registerQuery.in).toHaveBeenCalledWith('qbo_txn_id', ['txn-1']);
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });
  it('does not treat a failed existing-evidence lookup as an empty set', async () => {
    const query = {
      select: vi.fn(), eq: vi.fn(), not: vi.fn(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'PRIVATE_ERROR' } }).then(resolve),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.not.mockReturnValue(query);
    mocks.from.mockReturnValue(query);
    await expect(getClaimedTransactionIds('realm-1')).rejects.toThrow('Could not verify transactions with existing evidence');
  });

  it('rejects a direct processing request for an archived document before downloading it', async () => {
    await expect(processInboxDocument('document-1', 'request-1')).rejects.toThrow('Document not found: document-1');

    expect(mocks.filters).toContainEqual({ table: 'inbox_documents', column: 'archived_at', value: null });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('stops processing when duplicate discovery fails instead of assuming no duplicate exists', async () => {
    const metadata = makeQuery('inbox_documents');
    metadata.single.mockResolvedValue({ data: { id: 'document-1', realm_id: 'realm-1', storage_path: 'inbox/realm-1/file.pdf', content_type: 'application/pdf' }, error: null });
    const duplicateQuery = {
      select: vi.fn(), eq: vi.fn(), not: vi.fn(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'PRIVATE_DB_ERROR' } }).then(resolve),
    };
    duplicateQuery.select.mockReturnValue(duplicateQuery);
    duplicateQuery.eq.mockReturnValue(duplicateQuery);
    duplicateQuery.not.mockReturnValue(duplicateQuery);
    mocks.from.mockReset().mockReturnValueOnce(metadata).mockReturnValueOnce(duplicateQuery);
    mocks.download.mockResolvedValue({ data: new Blob(['%PDF fixture']), error: null });

    await expect(processInboxDocument('document-1', 'request-1'))
      .rejects.toThrow('Could not verify existing documents for duplicate detection');
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });
});
