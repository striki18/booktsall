
"use client";

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type WorkspaceSection = 'overview' | 'generate' | 'evidence' | 'missing' | 'attachments';
type WorkspacePanel = 'work' | 'packages' | 'profile' | null;
type QboConnectionState = 'checking' | 'connected' | 'needs_connection' | 'signed_out' | 'unavailable';
export type WordingMode = 'general' | 'finance';

export function ZevidtLogo({ inverse = false, compact = false }: { inverse?: boolean; compact?: boolean }) {
  return (
    <span className={`zevidtLogo${inverse ? ' zevidtLogoInverse' : ''}${compact ? ' zevidtLogoCompact' : ''}`}>
      <svg className="zevidtLogoMark" viewBox="0 0 36 36" aria-hidden="true">
        <rect x="1" y="1" width="34" height="34" rx="10" />
        <path d="M10 11.5h16L11 24.5h15" />
        <path d="m21.5 20.5 3 3 5.5-6" />
      </svg>
      {!compact ? <span className="zevidtLogoWord">ZEVIDT</span> : null}
    </span>
  );
}

export function useWordingMode() {
  const [wording, setWording] = useState<WordingMode>('general');

  useEffect(() => {
    const saved = window.localStorage.getItem('zevidt:wording');
    if (saved === 'finance' || saved === 'general') setWording(saved);
    const syncWording = (event: Event) => {
      const value = (event as CustomEvent<WordingMode>).detail;
      if (value === 'finance' || value === 'general') setWording(value);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === 'zevidt:wording' && (event.newValue === 'finance' || event.newValue === 'general')) {
        setWording(event.newValue);
      }
    };
    window.addEventListener('zevidt:wording-change', syncWording);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener('zevidt:wording-change', syncWording);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  function chooseWording(value: WordingMode) {
    setWording(value);
    window.localStorage.setItem('zevidt:wording', value);
    window.dispatchEvent(new CustomEvent('zevidt:wording-change', { detail: value }));
  }

  return { wording, setWording: chooseWording };
}

const workspaceSections: { id: WorkspaceSection; general: string; finance: string }[] = [
  { id: 'overview', general: 'Activity', finance: 'Overview' },
  { id: 'generate', general: 'Create a report', finance: 'Generate package' },
  { id: 'evidence', general: 'Documents and transactions', finance: 'Evidence register' },
  { id: 'missing', general: 'Needs documents', finance: 'Missing documents' },
  { id: 'attachments', general: 'Files', finance: 'Attachments' },
];

export function WorkspaceHeader({
  activeSection,
  onSelectSection,
}: {
  activeSection?: WorkspaceSection;
  onSelectSection?: (section: WorkspaceSection) => void;
}) {
  const pathname = usePathname();
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [qboConnectionState, setQboConnectionState] = useState<QboConnectionState>('checking');
  const { wording, setWording } = useWordingMode();
  const financeMode = wording === 'finance';
  const isHomeOverview = pathname === '/quickbooks' && (!activeSection || activeSection === 'overview');

  useEffect(() => {
    let active = true;
    fetch('/api/auth/intuit/token')
      .then((response) => {
        if (!active) return;
        if (response.ok) setQboConnectionState('connected');
        else if (response.status === 401) setQboConnectionState('signed_out');
        else if (response.status === 403 || response.status === 404) setQboConnectionState('needs_connection');
        else setQboConnectionState('unavailable');
      })
      .catch(() => {
        if (active) setQboConnectionState('unavailable');
      });
    return () => { active = false; };
  }, [pathname]);

  useEffect(() => {
    if (!panel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [panel]);

  function connectQuickBooks() {
    if (qboConnectionState === 'signed_out') {
      window.location.assign('/login');
    } else if (qboConnectionState === 'needs_connection') {
      window.location.assign('/api/auth/intuit');
    }
  }

  async function signOut() {
    setSigningOut(true);
    setSessionError(null);
    try {
      const { error } = await supabaseBrowser.auth.signOut({ scope: 'local' });
      if (error) throw error;
      window.location.replace('/login');
    } catch {
      setSessionError('Unable to sign out. Please try again.');
      setSigningOut(false);
    }
  }

  function openSection(section: WorkspaceSection) {
    if (pathname === '/quickbooks' && onSelectSection) {
      onSelectSection(section);
      setPanel(null);
      return;
    }
    window.location.assign(`/quickbooks?section=${section}`);
  }

  return (
    <>
      <header className="workspaceTopbar">
        <Link href="/quickbooks" className="workspaceBrand" aria-label="Zevidt home">
          <ZevidtLogo />
        </Link>

        <nav className="workspacePrimaryNav" aria-label="Primary navigation">
          <Link href="/quickbooks" className={pathname === '/quickbooks' ? 'isCurrent' : ''} onClick={(event) => {
            if (pathname === '/quickbooks' && onSelectSection) {
              event.preventDefault();
              onSelectSection('overview');
              setPanel(null);
            }
          }}>Home</Link>
          <Link href="/documents" className={pathname === '/documents' ? 'isCurrent' : ''}>{financeMode ? 'Documents' : 'Inbox'}</Link>
          <button type="button" aria-expanded={panel === 'work'} onClick={() => setPanel(panel === 'work' ? null : 'work')}>
            Transactions
          </button>
          <Link href="/review" className={pathname === '/review' ? 'isCurrent' : ''}>{financeMode ? 'Evidence review' : 'Needs a look'}</Link>
          <button type="button" aria-expanded={panel === 'packages'} onClick={() => setPanel(panel === 'packages' ? null : 'packages')}>
            Packages
          </button>
        </nav>

        <div className="workspaceTopbarActions">
          <div className="wordingToggle" role="group" aria-label="Language">
            <button type="button" aria-pressed={!financeMode} onClick={() => setWording('general')}>General</button>
            <button type="button" aria-pressed={financeMode} onClick={() => setWording('finance')}>Finance</button>
          </div>
          {qboConnectionState !== 'signed_out' ? (
            <button type="button" className="workspaceProfileButton" aria-label="Open profile menu" aria-expanded={panel === 'profile'} onClick={() => setPanel(panel === 'profile' ? null : 'profile')}>Z</button>
          ) : null}
        </div>
      </header>
      {sessionError ? <p role="alert" className="px-6 py-2 text-sm text-red-700">{sessionError}</p> : null}

      {!isHomeOverview && qboConnectionState !== 'connected' && qboConnectionState !== 'checking' && qboConnectionState !== 'unavailable' ? (
        <div className="workspaceConnectPrompt" role="status">
          <div>
            <strong>Connect QuickBooks to see more here</strong>
            <span>Load this company’s transactions and related details into Zevidt.</span>
          </div>
          <button type="button" className="workspaceConnectButton" onClick={connectQuickBooks}>
            {qboConnectionState === 'signed_out' ? 'Sign in to connect' : 'Connect QuickBooks'}
          </button>
        </div>
      ) : null}

      {panel ? (
        <>
          <button type="button" className="workspacePanelScrim" aria-label="Close menu" onClick={() => setPanel(null)} />
          <aside className="workspaceSidePanel" aria-label={panel === 'work' ? 'Transaction menu' : panel === 'packages' ? 'Package menu' : 'Profile menu'}>
            <div className="workspacePanelHeading">
              <div>
                <p>{panel === 'work' ? 'TRANSACTIONS' : panel === 'packages' ? 'EXPORTS & AUDITS' : 'ACCOUNT'}</p>
                <h2>{panel === 'work' ? 'Transactions' : panel === 'packages' ? 'Packages' : 'Profile'}</h2>
              </div>
              <button type="button" aria-label="Close menu" onClick={() => setPanel(null)}>×</button>
            </div>
            {panel === 'work' ? (
              <div className="workspacePanelLinks">
                {workspaceSections.map((section) => (
                  <button key={section.id} type="button" className={activeSection === section.id ? 'isCurrent' : ''} onClick={() => openSection(section.id)}>
                    <span>{financeMode ? section.finance : section.general}</span>
                  </button>
                ))}
                <Link href="/firm/inbox" onClick={() => setPanel(null)}>{financeMode ? 'Collection requests' : 'Client requests'}</Link>
              </div>
            ) : panel === 'packages' ? (
              <div className="workspacePanelLinks">
                <button type="button" onClick={() => openSection('generate')}>Create package</button>
                <Link href="/packages" onClick={() => setPanel(null)}>Package history</Link>
                <Link href="/audit-packages" onClick={() => setPanel(null)}>Audit packages</Link>
                <button type="button" onClick={() => openSection('attachments')}>QuickBooks files</button>
              </div>
            ) : (
              <div className="workspacePanelLinks">
                <button type="button" onClick={() => { setPanel(null); window.location.assign('/quickbooks?settings=integrations'); }}>Settings & integrations</button>
                <button type="button" className="workspaceSignOut" onClick={() => void signOut()} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
              </div>
            )}
          </aside>
        </>
      ) : null}
    </>
  );
}

// SVG Icons - accept and forward props for className, style, etc.
interface IconProps {
  className?: string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
}

export function OverviewIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function GenerateIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function EvidenceIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function MissingIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function AttachmentsIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export function LinkIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function CopyIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function SettingsIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function MenuIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function CloseIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function CheckIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function XIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function SpinnerIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="1">
        <animateTransform attributeName="transform" type="rotate" dur="1s" from="0 12 12" to="360 12 12" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

export function AlertIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
