'use client';

import { useCallback, useEffect, useState } from 'react';
import { WorkspaceHeader, useWordingMode } from '@/app/quickbooks/icons';

type PackageHistoryItem = {
  id: string;
  source_type: string;
  status: string;
  created_at: string;
  zip_path: string | null;
  filename?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  engagement_id?: string | null;
  package_version?: number | null;
  previous_package_id?: string | null;
  error_summary?: string | null;
};

export default function PackageHistoryPage() {
  const { wording } = useWordingMode();
  const financeMode = wording === 'finance';
  const [packages, setPackages] = useState<PackageHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/evidence/history');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load package history');
      if (!Array.isArray(body)) throw new Error('Package history response was invalid');
      setPackages(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load package history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  async function downloadPackage(item: PackageHistoryItem) {
    setDownloadingId(item.id);
    setError(null);
    try {
      if (item.source_type === 'legacy_engagement') {
        const response = await fetch(`/api/evidence/package/${encodeURIComponent(item.id)}/download`);
        const body = await response.json();
        if (!response.ok || typeof body.downloadUrl !== 'string') throw new Error(body.error || 'Package is not available for download');
        window.location.assign(body.downloadUrl);
        return;
      }
      const response = await fetch(`/api/download?packageId=${encodeURIComponent(item.id)}`);
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || 'Package download failed');
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = item.filename || `EvidencePackage_${item.id}.zip`;
      anchor.click();
      window.URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Package download failed');
    } finally {
      setDownloadingId(null);
    }
  }

  function canDownload(item: PackageHistoryItem) {
    return item.source_type === 'legacy_engagement'
      ? (item.status === 'ready' || item.status === 'partial') && Boolean(item.zip_path)
      : (item.status === 'complete' || item.status === 'partial') && Boolean(item.zip_path);
  }

  function exportSelectedPackages() {
    const selected = packages.filter((item) => selectedIds.has(item.id));
    if (!selected.length) return;
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['Filename', 'Status', 'Source', 'Created at', 'Start date', 'End date', 'Version'],
      ...selected.map((item) => [item.filename, item.status, item.source_type, item.created_at, item.start_date, item.end_date, item.package_version]),
    ];
    const url = window.URL.createObjectURL(new Blob([rows.map((row) => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `Zevidt-package-history-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); window.URL.revokeObjectURL(url);
  }

  async function downloadSelectedPackages() {
    const selected = packages.filter((item) => selectedIds.has(item.id) && canDownload(item));
    setBulkDownloading(true);
    try {
      for (const item of selected) await downloadPackage(item);
    } finally {
      setBulkDownloading(false);
    }
  }

  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent">
      <section className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-6 border-b border-[#e4e7ec] pb-7">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[#3159c9]">Package library</p>
            <h1 className="mt-3 text-3xl font-semibold">{financeMode ? 'Evidence package history' : 'Past reports and packages'}</h1>
            <p className="mt-3 text-base leading-7 text-[#667085]">{financeMode ? 'Find a past package, check what it contains, and download it again.' : 'Open a past report, see what went into it, or download it again.'}</p>
          </div>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => window.location.assign('/quickbooks?section=generate')} className="h-11 rounded-[9px] bg-[#3e6ae1] px-5 font-semibold text-white shadow-[0_4px_12px_rgba(62,106,225,.18)] hover:-translate-y-px hover:bg-[#2f56c7]">Create package</button><button type="button" onClick={() => void loadHistory()} disabled={loading} className="h-11 rounded-[9px] border border-[#d0d5dd] bg-white px-4 font-semibold text-[#344054] hover:border-[#98a2b3] disabled:opacity-60">{loading ? 'Loading…' : 'Refresh'}</button></div>
        </header>

        {error ? <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        {loading && packages.length === 0 ? <p className="rounded-2xl border border-[#e4e7ec] bg-white p-6 text-sm shadow-[0_1px_3px_rgba(16,24,40,.04)]">Loading package history…</p> : null}
        {!loading && packages.length === 0 ? <p className="rounded-2xl border border-[#e4e7ec] bg-white p-8 text-sm text-[#667085] shadow-[0_1px_3px_rgba(16,24,40,.04)]">No package runs are available for this company.</p> : null}

        {packages.length > 0 ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e4e7ec] bg-white px-4 py-3 shadow-[0_1px_3px_rgba(16,24,40,.04)]"><label className="flex items-center gap-3 text-sm font-semibold text-[#344054]"><input type="checkbox" checked={packages.every((item) => selectedIds.has(item.id))} onChange={() => setSelectedIds((current) => packages.every((item) => current.has(item.id)) ? new Set() : new Set(packages.map((item) => item.id)))} className="h-4 w-4 accent-[#3e6ae1]" />Select all packages</label>{selectedIds.size > 0 ? <div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-[#3159c9]">{selectedIds.size} selected</strong><button type="button" onClick={exportSelectedPackages} className="h-10 rounded-[9px] border border-[#b8c6ea] px-4 text-sm font-semibold text-[#3159c9]">Export CSV</button><button type="button" disabled={bulkDownloading} onClick={() => void downloadSelectedPackages()} className="h-10 rounded-[9px] bg-[#3e6ae1] px-4 text-sm font-semibold text-white disabled:opacity-60">{bulkDownloading ? 'Preparing…' : 'Download selected'}</button><button type="button" onClick={() => setSelectedIds(new Set())} className="h-10 px-3 text-sm font-semibold text-[#667085]">Clear</button></div> : null}</div> : null}

        <div className="grid gap-3">
          {packages.map(item => (
            <article key={item.id} className="flex flex-wrap items-center justify-between gap-5 rounded-2xl border border-[#e4e7ec] bg-white p-6 shadow-[0_1px_3px_rgba(16,24,40,.04)] transition hover:border-[#cbd5ed] hover:shadow-[0_12px_28px_rgba(16,24,40,.07)]">
              <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })} aria-label={`Select ${item.filename || 'evidence package'}`} className="h-4 w-4 accent-[#3e6ae1]" />
              <div className="min-w-64 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{item.filename || (item.engagement_id ? `Engagement package ${item.engagement_id}` : 'Evidence package')}</h2>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${item.status === 'partial' ? 'bg-amber-100 text-amber-900' : item.status === 'failed' ? 'bg-red-100 text-red-800' : item.status === 'complete' || item.status === 'ready' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700'}`}>{item.status}</span>
                </div>
                <p className="mt-2 text-sm text-[#667085]">{item.source_type === 'qbo_period' ? 'QuickBooks date range' : item.source_type === 'engagement' ? 'Engagement evidence' : 'Historical engagement package'} · {new Date(item.created_at).toLocaleString()}</p>
                {item.start_date || item.end_date ? <p className="mt-1 text-xs text-[#5d6675]">{item.start_date || 'Start unknown'} to {item.end_date || 'End unknown'} · Version {item.package_version || 1}</p> : item.package_version ? <p className="mt-1 text-xs text-[#5d6675]">Version {item.package_version}</p> : null}
                {item.previous_package_id ? <p className="mt-1 text-xs text-[#5d6675]">Previous version: {item.previous_package_id}</p> : null}
                {item.error_summary ? <p className="mt-2 text-sm text-amber-900">{item.error_summary}</p> : null}
              </div>
              <button type="button" disabled={!canDownload(item) || downloadingId === item.id} onClick={() => void downloadPackage(item)} className="h-11 rounded-[9px] border border-[#d0d5dd] bg-white px-4 text-sm font-semibold text-[#344054] hover:border-[#3e6ae1] hover:text-[#3159c9] disabled:cursor-not-allowed disabled:opacity-50">{downloadingId === item.id ? 'Preparing…' : 'Download ZIP'}</button>
            </article>
          ))}
        </div>
      </section>
      </main>
    </div>
  );
}
