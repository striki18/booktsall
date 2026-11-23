"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Company = { realm_id: string; company_name: string | null };

export function CompanySwitcher({ compact = false }: { compact?: boolean }) {
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

  return (
    <div className={compact ? 'companySwitcher companySwitcherCompact' : 'companySwitcher'}>
      {companies.length ? <label>
        <span className={compact ? 'sr-only' : ''}>Company</span>
        <select
          aria-label="Active QuickBooks company"
          value={activeRealmId}
          disabled={switching || companies.length < 2}
          onChange={(event) => void selectCompany(event.target.value)}
          className="companySwitcherSelect"
        >
          {companies.map((company, index) => (
            <option key={company.realm_id} value={company.realm_id}>
              {company.company_name || (companies.length > 1 ? `QuickBooks company ${index + 1}` : 'QuickBooks company')}
            </option>
          ))}
        </select>
      </label> : null}
      {!compact || companies.length === 0 ? <a href="/api/auth/intuit" className="companySwitcherAdd">+ Add company</a> : null}
      {!compact ? <Link href="/firm" className="companySwitcherManage">Manage</Link> : null}
      {switching ? <span role="status">Switching…</span> : null}
      {error ? <span role="alert" className="text-red-700">{error}</span> : null}
    </div>
  );
}
