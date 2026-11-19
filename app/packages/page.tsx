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

  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent">
      <section className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[#d9dde5] pb-6">
          <div>
            <h1 className="mt-3 text-3xl font-semibold">{financeMode ? 'Evidence package history' : 'Past reports and packages'}</h1>
            <p className="mt-2 text-sm leading-6 text-[#5d6675]">{financeMode ? 'Find a past package, check what it contains, and download it again.' : 'Open a past report, see what went into it, or download it again.'}</p>
          </div>
          <button type="button" onClick={() => void loadHistory()} disabled={loading} className="h-10 rounded bg-[#243b53] px-4 font-semibold text-white disabled:opacity-60">{loading ? 'Loading…' : 'Refresh history'}</button>
        </header>

        {error ? <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        {loading && packages.length === 0 ? <p className="rounded border border-[#d9dde5] bg-white p-6 text-sm">Loading package history…</p> : null}
        {!loading && packages.length === 0 ? <p className="rounded border border-[#d9dde5] bg-white p-6 text-sm text-[#5d6675]">No package runs are available for this company.</p> : null}

        <div className="grid gap-3">
          {packages.map(item => (
            <article key={item.id} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#d9dde5] bg-white p-5">
              <div className="min-w-64 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{item.filename || (item.engagement_id ? `Engagement package ${item.engagement_id}` : 'Evidence package')}</h2>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${item.status === 'partial' ? 'bg-amber-100 text-amber-900' : item.status === 'failed' ? 'bg-red-100 text-red-800' : item.status === 'complete' || item.status === 'ready' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700'}`}>{item.status}</span>
                </div>
                <p className="mt-1 text-sm text-[#5d6675]">{item.source_type === 'qbo_period' ? 'QuickBooks date range' : item.source_type === 'engagement' ? 'Engagement evidence' : 'Historical engagement package'} · {new Date(item.created_at).toLocaleString()}</p>
                {item.start_date || item.end_date ? <p className="mt-1 text-xs text-[#5d6675]">{item.start_date || 'Start unknown'} to {item.end_date || 'End unknown'} · Version {item.package_version || 1}</p> : item.package_version ? <p className="mt-1 text-xs text-[#5d6675]">Version {item.package_version}</p> : null}
                {item.previous_package_id ? <p className="mt-1 text-xs text-[#5d6675]">Previous version: {item.previous_package_id}</p> : null}
                {item.error_summary ? <p className="mt-2 text-sm text-amber-900">{item.error_summary}</p> : null}
              </div>
              <button type="button" disabled={!canDownload(item) || downloadingId === item.id} onClick={() => void downloadPackage(item)} className="h-10 rounded border border-[#c8ced8] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">{downloadingId === item.id ? 'Preparing…' : 'Download ZIP'}</button>
            </article>
          ))}
        </div>
      </section>
      </main>
    </div>
  );
}
