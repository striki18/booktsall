'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { WorkspaceHeader } from '@/app/quickbooks/icons';
import styles from './page.module.css';

type Company = {
  realmId: string;
  companyName: string;
  active: boolean;
  connection: 'connected' | 'needs_attention' | 'unknown';
  dataAvailable: boolean;
  transactions: number;
  matched: number;
  missing: number;
  reviewRequired: number;
  wrongMatched: number;
  inboxDocuments: number;
  processingDocuments: number;
};

export default function FirmDashboardPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/firm/dashboard', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load companies');
      setCompanies(body.companies ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load companies');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const totals = useMemo(() => companies.reduce((result, company) => ({
    transactions: result.transactions + company.transactions,
    missing: result.missing + company.missing,
    review: result.review + company.reviewRequired,
    documents: result.documents + company.inboxDocuments,
  }), { transactions: 0, missing: 0, review: 0, documents: 0 }), [companies]);

  async function openCompany(company: Company) {
    setSwitching(company.realmId);
    setError(null);
    try {
      if (!company.active) {
        const response = await fetch('/api/quickbooks/companies', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ realmId: company.realmId }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to switch company');
      }
      window.location.assign('/quickbooks');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to switch company');
      setSwitching(null);
    }
  }

  return (
    <>
      <WorkspaceHeader />
      <main className={styles.page}>
        <section className={styles.hero}>
          <div><p className={styles.eyebrow}>FIRM WORKSPACE</p><h1>Every company, one clear view.</h1><p>See connections, missing documents, and review work without opening each company first.</p></div>
          <Link className={styles.primary} href="/api/auth/intuit">Connect another company</Link>
        </section>

        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        <section className={styles.summary} aria-label="Firm totals">
          <div><span>Companies</span><strong>{companies.length}</strong></div>
          <div><span>Transactions</span><strong>{totals.transactions}</strong></div>
          <div><span>Missing documents</span><strong>{totals.missing}</strong></div>
          <div><span>Needs review</span><strong>{totals.review}</strong></div>
          <div><span>Inbox documents</span><strong>{totals.documents}</strong></div>
        </section>

        <section className={styles.list} aria-busy={loading}>
          <div className={styles.listHeading}><div><h2>Companies</h2><p>Connection and evidence health for each authorized QuickBooks company.</p></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
          {!loading && companies.length === 0 ? <div className={styles.empty}><h3>No companies connected</h3><p>Connect a QuickBooks company to begin collecting and reviewing documents.</p></div> : null}
          {companies.map((company) => (
            <article className={styles.company} key={company.realmId}>
              <div className={styles.companyIdentity}><span className={company.connection === 'connected' ? styles.connected : styles.attention} /> <div><h3>{company.companyName}</h3><p>{company.connection === 'connected' ? 'QuickBooks connected' : company.connection === 'needs_attention' ? 'Connection needs attention' : 'Connection status unavailable'}</p></div></div>
              <dl><div><dt>Transactions</dt><dd>{company.dataAvailable ? company.transactions : '—'}</dd></div><div><dt>Missing</dt><dd>{company.dataAvailable ? company.missing : '—'}</dd></div><div><dt>Needs review</dt><dd>{company.dataAvailable ? company.reviewRequired : '—'}</dd></div><div><dt>Inbox</dt><dd>{company.dataAvailable ? company.inboxDocuments : '—'}</dd></div></dl>
              <button type="button" className={styles.openButton} disabled={switching === company.realmId} onClick={() => void openCompany(company)}>{switching === company.realmId ? 'Opening…' : company.active ? 'Open workspace' : 'Switch and open'}</button>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
