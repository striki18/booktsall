"use client";

import { useEffect, useState } from 'react';

type Company = { realm_id: string; company_name: string | null };

export function CompanySwitcher() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [activeRealmId, setActiveRealmId] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch('/api/quickbooks/companies', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load companies');
        if (active) {
          setCompanies(body.companies ?? []);
          setActiveRealmId(body.activeRealmId ?? '');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load companies');
      });
    return () => { active = false; };
  }, []);

  async function selectCompany(realmId: string) {
    if (!realmId || realmId === activeRealmId) return;
    setSwitching(true);
    setError('');
    try {
      const response = await fetch('/api/quickbooks/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realmId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to switch company');
      setActiveRealmId(body.activeRealmId);
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to switch company');
    } finally {
      setSwitching(false);
    }
  }

  if (companies.length < 2 && !error) return null;

  return (
    <label className="flex items-center gap-2 text-xs font-medium text-neutral-600">
      <span>Company</span>
      <select
        aria-label="Active QuickBooks company"
        value={activeRealmId}
        disabled={switching || companies.length < 2}
        onChange={(event) => void selectCompany(event.target.value)}
        className="max-w-52 rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 disabled:opacity-60"
      >
        {companies.map((company) => (
          <option key={company.realm_id} value={company.realm_id}>
            {company.company_name || `Company ${company.realm_id}`}
          </option>
        ))}
      </select>
      {switching ? <span role="status">Switching…</span> : null}
      {error ? <span role="alert" className="text-red-700">{error}</span> : null}
    </label>
  );
}
