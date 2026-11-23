"use client";

import { useEffect, useState, useCallback } from 'react';
import { buildQboTransactionUrl } from '@/lib/qbo-links';
import { countEvidenceRegisterStates, filterAndSortEvidenceRegister, type EvidenceRegisterSort, type EvidenceRegisterState, type EvidenceRegisterViewRow } from '@/lib/evidence-register-view';
import { WorkspaceHeader, useWordingMode } from './icons';
import styles from './page.module.css';

interface CompanyInfo {
  CompanyInfo?: {
    CompanyName?: string;
    LegalName?: string;
    Country?: string;
    Currency?: string;
    Email?: Address;
    Phone?: Phone;
    WebAddr?: WebAddr;
    CompanyAddr?: Address;
  };
}

interface Address {
  Id?: string;
  Line1?: string;
  Line2?: string;
  Line3?: string;
  City?: string;
  Country?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
}

interface Phone {
  FreeFormNumber?: string;
}

interface WebAddr {
  URI?: string;
}

interface PipelineStats {
  transactionCount: number;
  attachableCount: number;
  matchedCount: number;
  missingCount: number;
  successfulDownloadCount: number;
  failedDownloadCount: number;
  zipSizeBytes: number;
  elapsedTimeMs: number;
}

interface PipelineError {
  stage: string;
  reason: string;
  details?: Record<string, unknown>;
}

interface GenerateResponse {
  success: boolean;
  packageId?: string;
  completionStatus?: 'complete' | 'partial';
  packagePath?: string;
  packageName?: string;
  stats?: PipelineStats;
  error?: PipelineError;
}

interface PipelineProgress {
  stage: string;
  status: 'started' | 'in_progress' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  counts?: Record<string, number>;
}

interface TokenInfo {
  realm_id: string;
  expires_at: string;
}

interface RegisterEntry {
  txnId?: string;
  hasAttachment?: boolean;
  txnType?: string;
  docNumber?: string;
  date?: string;
  vendor?: string;
  amount?: string | number;
}

interface WorkspaceTransaction {
  txnId: string | null;
  txnType: string | null;
  date: string | null;
  vendor: string | null;
  amount: number | null;
  docNumber: string | null;
  account: string | null;
  split: string | null;
  uncategorized: boolean;
}

interface WorkspaceAttachable {
  attachableId: string | null;
  fileName: string | null;
  fileSize: number | string | null;
  entityType: string | null;
  entityId: string | null;
  orphaned: boolean;
}

interface TransactionQuestion {
  id: string;
  qbo_txn_id: string;
  qbo_txn_type: string | null;
  qbo_txn_date: string | null;
  qbo_txn_vendor: string | null;
  qbo_txn_amount: number | null;
  qbo_txn_doc_number: string | null;
  audience: 'client' | 'accountant';
  status: 'open' | 'answered' | 'resolved';
  messages: Array<{ id: string; author_role: 'firm' | 'client' | 'accountant'; body: string; created_at: string }>;
}

type NavSection = 'overview' | 'generate' | 'evidence' | 'missing' | 'attachments' | 'requirements';

interface EvidenceRequirementRule {
  id: string;
  name: string;
  transaction_type: string;
  amount_min: number | string | null;
  amount_max: number | string | null;
  document_type: string;
  is_active: boolean;
}

interface RequirementEvaluation {
  transaction: { txnId: string; txnType: string | null; date: string | null; amount: number | null; vendor: string | null; docNumber: string | null };
  status: 'satisfied' | 'missing' | 'review_required' | 'unknown' | 'not_applicable' | 'not_configured';
  checks: Array<{ ruleId: string; ruleName: string; documentType: string; status: string; evidenceCount: number }>;
}

function downloadCsvFile(filename: string, headers: string[], rows: unknown[][]) {
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const content = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  const url = window.URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.URL.revokeObjectURL(url);
}

function evidenceSelectionKey(row: EvidenceRegisterViewRow, index: number) {
  return String(row.id ?? `${row.qboTxnId ?? 'unlinked'}-${row.matchedDocumentId ?? index}`);
}

function localDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const PIPELINE_STAGES = [
  { key: 'transactions', label: 'Retrieving Transactions' },
  { key: 'attachables', label: 'Retrieving Attachables' },
  { key: 'matching', label: 'Evidence Register Matching' },
  { key: 'download', label: 'Attachment Download' },
  { key: 'csv', label: 'Evidence CSV Generation' },
  { key: 'zip', label: 'ZIP Generation' },
  { key: 'complete', label: 'Pipeline Complete' },
];

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <OverviewIcon /> },
  { id: 'generate', label: 'Generate', icon: <GenerateIcon /> },
  { id: 'evidence', label: 'Evidence', icon: <EvidenceIcon /> },
  { id: 'missing', label: 'Missing Documents', icon: <MissingIcon /> },
  { id: 'attachments', label: 'Attachments', icon: <AttachmentsIcon /> },
  { id: 'requirements', label: 'Evidence rules', icon: <SettingsIcon /> },
];

function getSectionLabel(section: NavSection, financeMode: boolean) {
  const labels: Record<NavSection, { general: string; finance: string }> = {
    overview: { general: 'Home', finance: 'Overview' },
    generate: { general: 'Create report', finance: 'Generate package' },
    evidence: { general: 'Documents & transactions', finance: 'Evidence register' },
    missing: { general: 'Needs documents', finance: 'Missing documents' },
    attachments: { general: 'Files', finance: 'Attachments' },
    requirements: { general: 'Evidence rules', finance: 'Evidence requirements' },
  };
  return labels[section][financeMode ? 'finance' : 'general'];
}

// SVG Icons - accept and forward props for className, style, etc.
interface IconProps {
  className?: string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
}

function OverviewIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function GenerateIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
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

function EvidenceIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
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

function MissingIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function AttachmentsIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function LinkIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CopyIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function SettingsIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CloseIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CheckIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SpinnerIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="1">
        <animateTransform attributeName="transform" type="rotate" dur="1s" from="0 12 12" to="360 12 12" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function AlertIcon({ className, style, 'aria-hidden': ariaHidden, 'aria-label': ariaLabel, ...props }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden={ariaHidden} aria-label={ariaLabel} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export default function QuickbooksPage() {
  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const { wording } = useWordingMode();
  const financeMode = wording === 'finance';

  // Connection state
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [realmId, setRealmId] = useState<string>('');
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'not_connected' | 'error'>('checking');
  const [authStatus, setAuthStatus] = useState<'checking' | 'signed_in' | 'signed_out' | 'error'>('checking');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Form state
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [workspaceTransactions, setWorkspaceTransactions] = useState<WorkspaceTransaction[]>([]);
  const [workspaceAttachables, setWorkspaceAttachables] = useState<WorkspaceAttachable[]>([]);
  const [workspaceTransactionError, setWorkspaceTransactionError] = useState<string | null>(null);
  const [workspaceAttachableError, setWorkspaceAttachableError] = useState<string | null>(null);
  const [workspaceActivityLoading, setWorkspaceActivityLoading] = useState(false);
  const [workspaceActivityLoaded, setWorkspaceActivityLoaded] = useState(false);
  const [workspaceActivityKey, setWorkspaceActivityKey] = useState('');
  const [workspaceActivityUpdatedAt, setWorkspaceActivityUpdatedAt] = useState<string | null>(null);
  const [activitySearch, setActivitySearch] = useState('');
  const [activityType, setActivityType] = useState('ALL');
  const [activityFileStatus, setActivityFileStatus] = useState<'ALL' | 'WITH_FILES' | 'WITHOUT_FILES'>('ALL');
  const [activityCategoryStatus, setActivityCategoryStatus] = useState<'ALL' | 'UNCATEGORIZED' | 'CATEGORIZED'>('ALL');
  const [activityMinAmount, setActivityMinAmount] = useState('');
  const [activityMaxAmount, setActivityMaxAmount] = useState('');
  const [activitySort, setActivitySort] = useState<'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'name_asc'>('date_desc');
  const [activityFiltersOpen, setActivityFiltersOpen] = useState(false);
  const [selectedActivityTxnIds, setSelectedActivityTxnIds] = useState<Set<string>>(new Set());
  const [questionTransaction, setQuestionTransaction] = useState<WorkspaceTransaction | null>(null);
  const [questionAudience, setQuestionAudience] = useState<'client' | 'accountant'>('client');
  const [questionBody, setQuestionBody] = useState('');
  const [questionSaving, setQuestionSaving] = useState(false);
  const [questionNotice, setQuestionNotice] = useState<string | null>(null);
  const [transactionQuestions, setTransactionQuestions] = useState<TransactionQuestion[]>([]);
  const [questionReplies, setQuestionReplies] = useState<Record<string, string>>({});

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [progressStages, setProgressStages] = useState<PipelineProgress[]>([]);
  const [currentStageIndex, setCurrentStageIndex] = useState(-1);
  const [generationResult, setGenerationResult] = useState<GenerateResponse | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Download state
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Inbox state
  const [inboxToken, setInboxToken] = useState<string | null>(null);
  const [selectedTxnIds, setSelectedTxnIds] = useState<string[]>([]);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Settings modal
  const [showSettings, setShowSettings] = useState(false);
  const [evidenceRows, setEvidenceRows] = useState<EvidenceRegisterViewRow[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceSearch, setEvidenceSearch] = useState('');
  const [evidenceStateFilter, setEvidenceStateFilter] = useState<EvidenceRegisterState | 'ALL'>('ALL');
  const [evidenceSort, setEvidenceSort] = useState<EvidenceRegisterSort>('date_desc');
  const [selectedEvidenceRow, setSelectedEvidenceRow] = useState<EvidenceRegisterViewRow | null>(null);
  const [selectedEvidenceRowIds, setSelectedEvidenceRowIds] = useState<Set<string>>(new Set());
  const [requirementRules, setRequirementRules] = useState<EvidenceRequirementRule[]>([]);
  const [requirementRows, setRequirementRows] = useState<RequirementEvaluation[]>([]);
  const [requirementsLoading, setRequirementsLoading] = useState(false);
  const [requirementsSaving, setRequirementsSaving] = useState(false);
  const [requirementsError, setRequirementsError] = useState<string | null>(null);
  const [requirementsNotice, setRequirementsNotice] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState('');
  const [ruleTransactionType, setRuleTransactionType] = useState('Bill');
  const [ruleAmountMin, setRuleAmountMin] = useState('');
  const [ruleAmountMax, setRuleAmountMax] = useState('');
  const [ruleDocumentType, setRuleDocumentType] = useState('invoice');
  const [registerStartDate, setRegisterStartDate] = useState(() => {
    const date = new Date();
    date.setDate(1);
    return localDateValue(date);
  });
  const [registerEndDate, setRegisterEndDate] = useState(() => localDateValue(new Date()));

  const loadTransactionQuestions = useCallback(async () => {
    if (authStatus !== 'signed_in' || !realmId) return;
    const response = await fetch('/api/transaction-questions', { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json();
    if (Array.isArray(body)) setTransactionQuestions(body);
  }, [authStatus, realmId]);

  useEffect(() => { void loadTransactionQuestions(); }, [loadTransactionQuestions]);

  const createTransactionQuestion = async () => {
    if (!questionTransaction?.txnId || !questionBody.trim()) return;
    setQuestionSaving(true);
    setQuestionNotice(null);
    try {
      const response = await fetch('/api/transaction-questions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qboTxnId: questionTransaction.txnId, qboTxnType: questionTransaction.txnType,
          qboTxnDate: questionTransaction.date, qboTxnVendor: questionTransaction.vendor,
          qboTxnAmount: questionTransaction.amount, qboTxnDocNumber: questionTransaction.docNumber,
          audience: questionAudience, question: questionBody.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to create question');
      setQuestionTransaction(null);
      setQuestionBody('');
      setQuestionNotice(questionAudience === 'client' ? 'Client question added to the no-login collection link.' : 'Accountant question added to the company queue.');
      await loadTransactionQuestions();
    } catch (error) {
      setQuestionNotice(error instanceof Error ? error.message : 'Unable to create question');
    } finally {
      setQuestionSaving(false);
    }
  };

  const replyToTransactionQuestion = async (question: TransactionQuestion) => {
    const body = questionReplies[question.id]?.trim();
    if (!body) return;
    setQuestionSaving(true);
    try {
      const response = await fetch(`/api/transaction-questions/${encodeURIComponent(question.id)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save reply');
      setQuestionReplies((current) => ({ ...current, [question.id]: '' }));
      await loadTransactionQuestions();
    } catch (error) {
      setQuestionNotice(error instanceof Error ? error.message : 'Unable to save reply');
    } finally {
      setQuestionSaving(false);
    }
  };

  const resolveTransactionQuestion = async (question: TransactionQuestion) => {
    setQuestionSaving(true);
    try {
      const response = await fetch('/api/transaction-questions', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: question.id, action: 'resolve' }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to resolve question');
      await loadTransactionQuestions();
    } catch (error) {
      setQuestionNotice(error instanceof Error ? error.message : 'Unable to resolve question');
    } finally {
      setQuestionSaving(false);
    }
  };

  const loadEvidenceRules = useCallback(async () => {
    setRequirementsLoading(true);
    setRequirementsError(null);
    try {
      const response = await fetch('/api/evidence/requirements', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body)) throw new Error(body.error || 'Unable to load evidence rules');
      setRequirementRules(body);
    } catch (error) {
      setRequirementsError(error instanceof Error ? error.message : 'Unable to load evidence rules');
    } finally {
      setRequirementsLoading(false);
    }
  }, []);

  const evaluateEvidenceRules = useCallback(async () => {
    if (!registerStartDate || !registerEndDate || registerStartDate > registerEndDate) {
      setRequirementsError('Choose a valid date range before evaluating.');
      return;
    }
    setRequirementsLoading(true);
    setRequirementsError(null);
    setRequirementsNotice(null);
    try {
      const query = new URLSearchParams({ startDate: registerStartDate, endDate: registerEndDate });
      const response = await fetch(`/api/evidence/requirements/evaluate?${query}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || 'Unable to evaluate evidence rules');
      setRequirementRows(body.rows);
      if (body.rows.length === 0) setRequirementsNotice('No cached transaction register rows were found for this date range. Refresh the transaction register first to load transactions.');
    } catch (error) {
      setRequirementsError(error instanceof Error ? error.message : 'Unable to evaluate evidence rules');
    } finally {
      setRequirementsLoading(false);
    }
  }, [registerStartDate, registerEndDate]);

  const createEvidenceRule = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRequirementsSaving(true);
    setRequirementsError(null);
    setRequirementsNotice(null);
    try {
      const response = await fetch('/api/evidence/requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ruleName,
          transaction_type: ruleTransactionType,
          amount_min: ruleAmountMin === '' ? null : Number(ruleAmountMin),
          amount_max: ruleAmountMax === '' ? null : Number(ruleAmountMax),
          document_type: ruleDocumentType,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to create evidence rule');
      setRuleName('');
      setRequirementRules((current) => [body, ...current]);
      setRequirementsNotice('Rule saved. It will apply only to matching transaction types and amounts.');
    } catch (error) {
      setRequirementsError(error instanceof Error ? error.message : 'Unable to create evidence rule');
    } finally {
      setRequirementsSaving(false);
    }
  };

  const toggleEvidenceRule = async (rule: EvidenceRequirementRule) => {
    setRequirementsError(null);
    setRequirementsNotice(null);
    try {
      const response = await fetch(`/api/evidence/requirements/${encodeURIComponent(rule.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !rule.is_active }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to update evidence rule');
      setRequirementRules((current) => current.map((item) => item.id === body.id ? body : item));
    } catch (error) {
      setRequirementsError(error instanceof Error ? error.message : 'Unable to update evidence rule');
    }
  };

  const fetchEvidenceRegister = useCallback(async () => {
    if (!realmId || !registerStartDate || !registerEndDate) return [];
    const params = new URLSearchParams({ realmId, startDate: registerStartDate, endDate: registerEndDate });
    const response = await fetch(`/api/evidence/qbo-register?${params.toString()}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Unable to load the evidence register');
    if (!Array.isArray(body)) throw new Error('The evidence register response was invalid');
    return body as EvidenceRegisterViewRow[];
  }, [realmId, registerStartDate, registerEndDate]);

  const loadEvidenceRegister = useCallback(async () => {
    if (!realmId || !registerStartDate || !registerEndDate) return;
    const cacheKey = `zevidt:register:${realmId}:${registerStartDate}:${registerEndDate}`;
    let restored = false;
    try {
      const cached = JSON.parse(window.sessionStorage.getItem(cacheKey) || 'null') as { savedAt?: number; rows?: EvidenceRegisterViewRow[] } | null;
      if (cached?.savedAt && Date.now() - cached.savedAt < 60_000 && Array.isArray(cached.rows)) {
        setEvidenceRows(cached.rows);
        restored = true;
      }
    } catch {
      window.sessionStorage.removeItem(cacheKey);
    }
    setEvidenceLoading(!restored);
    setEvidenceError(null);
    try {
      const rows = await fetchEvidenceRegister();
      setEvidenceRows(rows);
      window.sessionStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), rows }));
    } catch (cause) {
      setEvidenceError(cause instanceof Error ? cause.message : 'Unable to load the evidence register');
      setEvidenceRows([]);
    } finally {
      setEvidenceLoading(false);
    }
  }, [realmId, registerStartDate, registerEndDate, fetchEvidenceRegister]);

  const selectWorkspaceSection = useCallback((section: NavSection) => {
    setActiveSection(section);
  }, []);

  useEffect(() => {
    if (activeSection === 'requirements' && authStatus === 'signed_in') void loadEvidenceRules();
  }, [activeSection, authStatus, loadEvidenceRules]);

  useEffect(() => {
    if ((activeSection === 'overview' || activeSection === 'evidence') && connectionStatus === 'connected' && realmId && evidenceRows.length === 0 && !evidenceLoading) {
      void loadEvidenceRegister();
    }
  }, [activeSection, connectionStatus, realmId, evidenceRows.length, evidenceLoading, loadEvidenceRegister]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('settings') === 'integrations') setShowSettings(true);
  }, []);

  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get('section');
    if (section && NAV_ITEMS.some((item) => item.id === section)) {
      setActiveSection(section as NavSection);
    }
  }, []);

  // Fetch connection status and company info
  const fetchConnectionStatus = useCallback(async () => {
    try {
      setConnectionStatus('checking');
      const res = await fetch('/api/quickbooks/companyInfo');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch company info');
      }
      const data = await res.json();
      setCompany(data);
      setConnectionStatus('connected');
      setConnectionError(null);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      setConnectionStatus('not_connected');
      setConnectionError(
        message === 'UNAUTHORIZED' || message === 'Authentication required'
          ? 'Sign in to Zevidt before connecting QuickBooks.'
          : message === 'NO_REALM_ID'
            ? 'Connect your QuickBooks sandbox to begin.'
            : message,
      );
      setCompany(null);
    }
  }, []);

  // Fetch token info
  const fetchTokenInfo = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/intuit/token');
      if (response.status === 401) {
        setAuthStatus('signed_out');
        return;
      }
      if (response.status === 403) {
        setAuthStatus('signed_in');
        return;
      }
      // The token-status route returns 404 for an authenticated user without
      // a connected QuickBooks company. That is a valid signed-in state.
      if (response.status === 404) {
        setAuthStatus('signed_in');
        setTokenInfo(null);
        setRealmId('');
        return;
      }
      if (!response.ok) {
        setAuthStatus('error');
        return;
      }
      const data = await response.json();
      setAuthStatus('signed_in');
      setTokenInfo(data);
      setRealmId(data.realm_id);
    } catch {
      setAuthStatus('error');
    }
  }, []);

  const fetchWorkspaceActivity = useCallback(async () => {
    if (!realmId || !startDate || !endDate) return;
    setWorkspaceActivityLoading(true);
    setWorkspaceTransactionError(null);
    setWorkspaceAttachableError(null);
    const transactionsRequest = fetch(
        `/api/quickbooks/transactions?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
        { cache: 'no-store' },
      ).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load QuickBooks transactions.');
      if (!Array.isArray(body)) throw new Error('QuickBooks returned an unexpected transaction response.');
      return body as WorkspaceTransaction[];
    });
    const attachablesRequest = fetch('/api/quickbooks/attachables', { cache: 'no-store' }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load linked QuickBooks files.');
      if (!Array.isArray(body)) throw new Error('QuickBooks returned an unexpected file response.');
      return body as WorkspaceAttachable[];
    });

    const [transactionsResult, attachablesResult] = await Promise.allSettled([transactionsRequest, attachablesRequest]);
    if (transactionsResult.status === 'fulfilled') setWorkspaceTransactions(transactionsResult.value);
    else setWorkspaceTransactionError(transactionsResult.reason instanceof Error ? transactionsResult.reason.message : 'Could not load QuickBooks transactions.');
    if (attachablesResult.status === 'fulfilled') setWorkspaceAttachables(attachablesResult.value);
    else setWorkspaceAttachableError(attachablesResult.reason instanceof Error ? attachablesResult.reason.message : 'Could not load linked QuickBooks files.');
    setWorkspaceActivityLoading(false);
    setWorkspaceActivityLoaded(true);
    setWorkspaceActivityUpdatedAt(new Date().toISOString());
  }, [realmId, startDate, endDate]);

  // Initialize on mount
  useEffect(() => {
    const init = async () => {
      const oauthFailed = new URLSearchParams(window.location.search).get('oauth') === 'failed';
      if (oauthFailed) {
        setConnectionStatus('error');
        setConnectionError('QuickBooks connection failed. Check the account and try again.');
      } else {
        await fetchConnectionStatus();
      }
      await fetchTokenInfo();
      if (!startDate) setStartDate('2023-01-01');
      if (!endDate) {
        const today = new Date();
        today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
        setEndDate(today.toISOString().slice(0, 10));
      }
    };
    init();
  }, [fetchConnectionStatus, fetchTokenInfo]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !realmId || !startDate || !endDate) return;
    const queryKey = `${realmId}:${startDate}:${endDate}`;
    if (workspaceActivityKey === queryKey) return;
    setWorkspaceActivityKey(queryKey);
    void fetchWorkspaceActivity();
  }, [connectionStatus, realmId, startDate, endDate, workspaceActivityKey, fetchWorkspaceActivity]);

  // Handle Connect QuickBooks
  const handleConnect = () => {
    if (authStatus === 'signed_out') {
      window.location.href = '/login';
      return;
    }
    if (authStatus !== 'signed_in') return;
    window.location.href = '/api/auth/intuit';
  };

  // Handle Refresh Connection
  const handleRefreshConnection = async () => {
    await fetchConnectionStatus();
    await fetchTokenInfo();
  };

  // Validate dates
  const validateDates = () => {
    if (!startDate || !endDate) {
      return 'Start date and end date are required';
    }
    if (startDate > endDate) {
      return 'Start date must be before or equal to end date';
    }
    return null;
  };

  // Handle Generate Package
  const handleGeneratePackage = async () => {
    const dateError = validateDates();
    if (dateError) {
      setGenerationError(dateError);
      return;
    }

    if (!realmId) {
      setGenerationError('No QuickBooks connection found. Please connect first.');
      return;
    }

    setGenerating(true);
    setProgressStages([]);
    setCurrentStageIndex(-1);
    setGenerationResult(null);
    setGenerationError(null);
    setDownloadError(null);

    // Switch to progress section
    setActiveSection('generate');

    try {
      const payload = { companyId: realmId, startDate, endDate };
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result: GenerateResponse = await res.json();

      if (!res.ok || !result.success) {
        throw new Error(result.error?.reason || 'Package generation failed');
      }

      setGenerationResult(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      setGenerationError(message);
    } finally {
      setGenerating(false);
    }
  };

  // Simulate progress through stages while generating
  useEffect(() => {
    if (generating) {
      let stageIndex = 0;
      const interval = setInterval(() => {
        setProgressStages(prev => {
          const newStages = [...prev];
          if (stageIndex < PIPELINE_STAGES.length) {
            if (newStages.length <= stageIndex) {
              newStages.push({
                stage: PIPELINE_STAGES[stageIndex].label,
                status: stageIndex === 0 ? 'started' : 'in_progress',
                message: `Processing ${PIPELINE_STAGES[stageIndex].label.toLowerCase()}...`,
                timestamp: new Date().toISOString(),
              });
            } else {
              newStages[stageIndex] = {
                ...newStages[stageIndex],
                status: 'in_progress',
              };
            }
            if (stageIndex > 0) {
              newStages[stageIndex - 1] = {
                ...newStages[stageIndex - 1],
                status: 'completed',
              };
            }
          }
          return newStages;
        });
        setCurrentStageIndex(stageIndex);
        stageIndex++;
        if (stageIndex >= PIPELINE_STAGES.length) {
          clearInterval(interval);
        }
      }, 2000);

      return () => clearInterval(interval);
    }
  }, [generating]);

  // Handle Download Package
  const handleDownload = async () => {
    if (!generationResult?.packageName || !generationResult.packageId) return;

    setDownloading(true);
    setDownloadError(null);

    try {
      const url = `/api/download?packageId=${encodeURIComponent(generationResult.packageId)}`;
      const res = await fetch(url);

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Download failed' }));
        throw new Error(errorData.error || `Download failed with status ${res.status}`);
      }

      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = generationResult.packageName || 'AuditPackage.zip';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="([^"]+)"/);
        if (match) filename = match[1];
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
    } catch (e: any) {
      setDownloadError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  // Handle Create Collection Request
  const handleCreateRequest = async () => {
    if (!realmId || selectedTxnIds.length === 0) return;

    setCreatingRequest(true);
    setRequestError(null);

    try {
      const res = await fetch('/api/firm/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realm_id: realmId, transaction_ids: selectedTxnIds }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to create collection request');
      }

      setInboxToken(data.token);
      setCopiedLink(false);
    } catch (e: any) {
      setRequestError(e.message);
    } finally {
      setCreatingRequest(false);
    }
  };

  // Handle Copy Inbox Link
  const handleCopyLink = async () => {
    if (!inboxToken) return;
    
    const link = `${window.location.origin}/inbox/${inboxToken}`;
    await navigator.clipboard.writeText(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Handle Transaction Selection
  const handleTxnSelect = (txnId: string, checked: boolean) => {
    if (checked) {
      setSelectedTxnIds(prev => [...prev, txnId]);
    } else {
      setSelectedTxnIds(prev => prev.filter(id => id !== txnId));
    }
  };

  // Handle Select All
  const handleSelectAll = (txnIds: string[], checked: boolean) => {
    if (checked) {
      setSelectedTxnIds(txnIds);
    } else {
      setSelectedTxnIds([]);
    }
  };

  // Format bytes
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Format duration
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  // Token health state
  const [tokenHealth, setTokenHealth] = useState<'healthy' | 'expiring' | 'expired' | 'refresh_failed' | 'unknown'>('unknown');
  const [tokenRefreshError, setTokenRefreshError] = useState<string | null>(null);

  // Check token health and update state
  const checkTokenHealth = useCallback(() => {
    if (!tokenInfo) {
      setTokenHealth('unknown');
      return;
    }
    const expiresAt = new Date(tokenInfo.expires_at).getTime();
    const now = Date.now();
    const minutesUntilExpiry = (expiresAt - now) / (1000 * 60);

    if (minutesUntilExpiry <= 0) {
      setTokenHealth('expired');
    } else if (minutesUntilExpiry < 10) {
      setTokenHealth('expiring');
    } else if (minutesUntilExpiry <= 60) {
      setTokenHealth('healthy');
    } else {
      setTokenHealth('healthy');
    }
  }, [tokenInfo]);

  // Check token health when tokenInfo changes
  useEffect(() => {
    checkTokenHealth();
  }, [tokenInfo, checkTokenHealth]);

  // Handle Reconnect QuickBooks - triggers full OAuth flow
  const handleReconnect = () => {
    setTokenRefreshError(null);
    window.location.href = '/api/auth/intuit';
  };

  // Handle Refresh Token - attempts to refresh the token via API
  const handleRefreshToken = async () => {
    setTokenRefreshError(null);
    try {
      // Call the company info endpoint which will trigger token refresh via getAccessToken()
      const res = await fetch('/api/quickbooks/companyInfo');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to refresh token');
      }
      await fetchConnectionStatus();
      await fetchTokenInfo();
    } catch (e: any) {
      setTokenHealth('refresh_failed');
      setTokenRefreshError(e.message);
    }
  };

  // Get connection health text
  const getConnectionHealth = useCallback(() => {
    if (!tokenInfo) return 'Unknown';
    const expiresAt = new Date(tokenInfo.expires_at).getTime();
    const now = Date.now();
    const minutesUntilExpiry = (expiresAt - now) / (1000 * 60);
    if (minutesUntilExpiry <= 0) return 'Expired';
    if (minutesUntilExpiry < 10) return 'Expiring Soon';
    return 'Healthy';
  }, [tokenInfo]);

  // Get token refresh status
  const getTokenRefreshStatus = useCallback(() => {
    if (!tokenInfo) return 'No Token';
    const expiresAt = new Date(tokenInfo.expires_at).getTime();
    const now = Date.now();
    const minutesUntilExpiry = (expiresAt - now) / (1000 * 60);
    if (minutesUntilExpiry <= 60) return 'Auto-refresh Active';
    return 'Valid';
  }, [tokenInfo]);

  // Render connection badge for header
  const renderHeaderConnectionBadge = () => {
    if (connectionStatus === 'checking') {
      return (
        <span className={styles.connectionDot + ' ' + styles.checking} aria-label="Checking connection" />
      );
    }
    if (connectionStatus === 'connected') {
      return <span className={styles.connectionDot + ' ' + styles.connected} aria-label="Connected" />;
    }
    return <span className={styles.connectionDot} aria-label="Not connected" />;
  };

  // Render connection status text for header
  const renderHeaderConnectionText = () => {
    if (connectionStatus === 'checking') return 'Checking...';
    if (connectionStatus === 'connected') return 'Connected';
    return 'Not Connected';
  };

  // Render connection badge for cards
  const renderConnectionBadge = () => {
    if (connectionStatus === 'checking') {
      return <span className={styles.badge + ' ' + styles.badgeChecking}>Checking...</span>;
    }
    if (connectionStatus === 'connected') {
      return <span className={styles.badge + ' ' + styles.badgeConnected}>CONNECTED</span>;
    }
    if (connectionStatus === 'error') {
      return <span className={styles.badge + ' ' + styles.badgeError}>ERROR</span>;
    }
    return <span className={styles.badge + ' ' + styles.badgeDisconnected}>NOT CONNECTED</span>;
  };

  // Section renderers
  const renderWorkspaceActivity = () => {
    const allTransactions = workspaceTransactions.filter((transaction) => transaction.txnId);
    const linkedFiles = workspaceAttachables.filter((attachable) => !attachable.orphaned && attachable.entityId);
    const orphanedFiles = workspaceAttachables.filter((attachable) => attachable.orphaned);
    const transactionIdsWithFiles = new Set(linkedFiles.map((attachable) => attachable.entityId).filter(Boolean));
    const normalizedSearch = activitySearch.trim().toLowerCase();
    const minAmount = activityMinAmount === '' ? null : Number(activityMinAmount);
    const maxAmount = activityMaxAmount === '' ? null : Number(activityMaxAmount);
    const transactionTypes = [...new Set(allTransactions.map((transaction) => transaction.txnType).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
    const transactions = allTransactions
      .filter((transaction) => activityType === 'ALL' || transaction.txnType === activityType)
      .filter((transaction) => activityFileStatus === 'ALL' || (activityFileStatus === 'WITH_FILES' ? transactionIdsWithFiles.has(transaction.txnId) : !transactionIdsWithFiles.has(transaction.txnId)))
      .filter((transaction) => activityCategoryStatus === 'ALL' || (activityCategoryStatus === 'UNCATEGORIZED' ? transaction.uncategorized : !transaction.uncategorized))
      .filter((transaction) => minAmount == null || (transaction.amount != null && transaction.amount >= minAmount))
      .filter((transaction) => maxAmount == null || (transaction.amount != null && transaction.amount <= maxAmount))
      .filter((transaction) => !normalizedSearch || [transaction.vendor, transaction.docNumber, transaction.txnType, transaction.txnId, transaction.account, transaction.split].some((value) => value?.toLowerCase().includes(normalizedSearch)))
      .sort((left, right) => {
        if (activitySort === 'date_asc') return (left.date || '').localeCompare(right.date || '');
        if (activitySort === 'amount_desc') return (right.amount ?? Number.NEGATIVE_INFINITY) - (left.amount ?? Number.NEGATIVE_INFINITY);
        if (activitySort === 'amount_asc') return (left.amount ?? Number.POSITIVE_INFINITY) - (right.amount ?? Number.POSITIVE_INFINITY);
        if (activitySort === 'name_asc') return (left.vendor || '').localeCompare(right.vendor || '');
        return (right.date || '').localeCompare(left.date || '');
      });

    return (
      <section className={`${styles.card} ${styles.activityCard}`} aria-labelledby="workspace-activity-title">
        <div className={styles.activityHeading}>
          <div>
            <h2 id="workspace-activity-title" className={styles.cardTitle}>{financeMode ? 'Transactions and evidence' : 'QuickBooks activity'}</h2>
            <p className={styles.activityDescription}>
              {financeMode
                ? 'Transactions and their linked QuickBooks files for the selected dates.'
                : 'See the transactions and files already linked in QuickBooks.'}
            </p>
          </div>
          {workspaceActivityUpdatedAt ? <span className={styles.activityUpdated}>Updated {new Date(workspaceActivityUpdatedAt).toLocaleTimeString()}</span> : null}
        </div>

        <form
          className={styles.activityFilters}
          onSubmit={(event) => { event.preventDefault(); void fetchWorkspaceActivity(); }}
        >
          <label className={styles.activityDateField}>
            <span>{financeMode ? 'Start date' : 'From'}</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
          </label>
          <label className={styles.activityDateField}>
            <span>{financeMode ? 'End date' : 'To'}</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required />
          </label>
          <button
            type="submit"
            className={styles.btn + ' ' + styles.btnPrimary}
            disabled={connectionStatus !== 'connected' || workspaceActivityLoading || !realmId}
          >
            {workspaceActivityLoading ? 'Loading…' : 'Refresh activity'}
          </button>
          {allTransactions.length > 0 ? <button
            type="button"
            className={styles.btn + ' ' + styles.btnSecondary}
            aria-expanded={activityFiltersOpen}
            onClick={() => setActivityFiltersOpen((open) => !open)}
          >
            {activityFiltersOpen ? 'Hide filters' : 'Filter & sort'}
          </button> : null}
        </form>

        {allTransactions.length > 0 && activityFiltersOpen ? <div className={styles.activityFilterBar} aria-label="Filter and sort transactions">
          <label className={styles.activitySearchField}><span>Search</span><input type="search" value={activitySearch} onChange={(event) => setActivitySearch(event.target.value)} placeholder="Name, number, type, or ID" /></label>
          <label><span>Type</span><select value={activityType} onChange={(event) => setActivityType(event.target.value)}><option value="ALL">All types</option>{transactionTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label><span>Documents</span><select value={activityFileStatus} onChange={(event) => setActivityFileStatus(event.target.value as 'ALL' | 'WITH_FILES' | 'WITHOUT_FILES')}><option value="ALL">All transactions</option><option value="WITH_FILES">With documents</option><option value="WITHOUT_FILES">Without documents</option></select></label>
          <label><span>Category</span><select value={activityCategoryStatus} onChange={(event) => setActivityCategoryStatus(event.target.value as 'ALL' | 'UNCATEGORIZED' | 'CATEGORIZED')}><option value="ALL">All categories</option><option value="UNCATEGORIZED">Uncategorized only</option><option value="CATEGORIZED">Categorized only</option></select></label>
          <label><span>Min amount</span><input type="number" min="0" step="0.01" value={activityMinAmount} onChange={(event) => setActivityMinAmount(event.target.value)} placeholder="0" /></label>
          <label><span>Max amount</span><input type="number" min="0" step="0.01" value={activityMaxAmount} onChange={(event) => setActivityMaxAmount(event.target.value)} placeholder="Any" /></label>
          <label><span>Sort</span><select value={activitySort} onChange={(event) => setActivitySort(event.target.value as typeof activitySort)}><option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option><option value="amount_desc">Amount: high to low</option><option value="amount_asc">Amount: low to high</option><option value="name_asc">Name: A–Z</option></select></label>
          {(activitySearch || activityType !== 'ALL' || activityFileStatus !== 'ALL' || activityCategoryStatus !== 'ALL' || activityMinAmount || activityMaxAmount || activitySort !== 'date_desc') ? <button type="button" className={styles.btn + ' ' + styles.btnLink} onClick={() => { setActivitySearch(''); setActivityType('ALL'); setActivityFileStatus('ALL'); setActivityCategoryStatus('ALL'); setActivityMinAmount(''); setActivityMaxAmount(''); setActivitySort('date_desc'); }}>Clear</button> : null}
        </div> : null}

        {connectionStatus !== 'connected' ? (
          <p className={styles.activityEmpty}>{authStatus === 'signed_out' ? 'Sign in to Zevidt, then connect QuickBooks to load this company’s activity.' : 'Connect QuickBooks to see this company’s transactions and linked files.'}</p>
        ) : null}
        {workspaceTransactionError ? <p className={styles.activityError} role="alert">{workspaceTransactionError}</p> : null}
        {workspaceAttachableError ? <p className={styles.activityWarning} role="status">Transaction results are available, but linked-file details could not be loaded: {workspaceAttachableError}</p> : null}

        {connectionStatus === 'connected' && !workspaceTransactionError && workspaceActivityLoaded && transactions.length === 0 ? (
          <p className={styles.activityEmpty}>No transactions were returned for these dates. Try a wider date range.</p>
        ) : null}

        {transactions.length > 0 ? (
          <>
            <p className={styles.activitySummary}>
              {transactions.length} of {allTransactions.length} transactions
              {!workspaceAttachableError ? ` · ${linkedFiles.length} transaction-linked file records · ${orphanedFiles.length} unattached file records` : ''}
            </p>
            {selectedActivityTxnIds.size > 0 ? <div className={styles.cardActions}>
              <strong>{selectedActivityTxnIds.size} selected</strong>
              <button type="button" className={styles.btn + ' ' + styles.btnPrimary} onClick={() => downloadCsvFile(`Zevidt-transactions-${new Date().toISOString().slice(0, 10)}.csv`, ['Date', 'Type', 'Number', 'Name', 'Amount', 'QBO ID', 'QuickBooks files'], transactions.filter((transaction) => transaction.txnId && selectedActivityTxnIds.has(transaction.txnId)).map((transaction) => [transaction.date, transaction.txnType, transaction.docNumber, transaction.vendor, transaction.amount, transaction.txnId, workspaceAttachables.filter((file) => !file.orphaned && file.entityId === transaction.txnId).length]))}>Export selected CSV</button>
              <button type="button" className={styles.btn + ' ' + styles.btnLink} onClick={() => setSelectedActivityTxnIds(new Set())}>Clear</button>
            </div> : null}
            <div className={styles.activityTableWrap}>
              <table className={styles.activityTable}>
                <thead>
                  <tr>
                    <th scope="col"><input type="checkbox" aria-label="Select all visible transactions" checked={transactions.length > 0 && transactions.every((transaction) => transaction.txnId && selectedActivityTxnIds.has(transaction.txnId))} onChange={() => setSelectedActivityTxnIds((current) => { const next = new Set(current); const allSelected = transactions.every((transaction) => transaction.txnId && next.has(transaction.txnId)); transactions.forEach((transaction) => { if (transaction.txnId) allSelected ? next.delete(transaction.txnId) : next.add(transaction.txnId); }); return next; })} /></th>
                    <th scope="col">Date</th>
                    <th scope="col">Type</th>
                    <th scope="col">Number</th>
                    <th scope="col">Name</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Category</th>
                    <th scope="col">QuickBooks files</th>
                    <th scope="col"><span className="sr-only">Ask for information</span></th>
                    <th scope="col"><span className="sr-only">QuickBooks link</span></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((transaction) => {
                    const qboUrl = buildQboTransactionUrl(transaction.txnType, transaction.txnId);
                    const files = [...new Map(
                      workspaceAttachables
                        .filter((attachable) => !attachable.orphaned && attachable.entityId === transaction.txnId && attachable.attachableId)
                        .map((attachable) => [attachable.attachableId, attachable]),
                    ).values()];
                    return (
                      <tr key={transaction.txnId}>
                        <td><input type="checkbox" aria-label={`Select transaction ${transaction.docNumber || transaction.txnId}`} checked={Boolean(transaction.txnId && selectedActivityTxnIds.has(transaction.txnId))} onChange={() => transaction.txnId && setSelectedActivityTxnIds((current) => { const next = new Set(current); next.has(transaction.txnId!) ? next.delete(transaction.txnId!) : next.add(transaction.txnId!); return next; })} /></td>
                        <td>{transaction.date || '—'}</td>
                        <td>{transaction.txnType || '—'}</td>
                        <td>{transaction.docNumber || '—'}</td>
                        <td>{transaction.vendor || '—'}</td>
                        <td>{transaction.amount == null ? '—' : `${company?.CompanyInfo?.Currency ? `${company.CompanyInfo.Currency} ` : ''}${transaction.amount.toLocaleString()}`}</td>
                        <td>{transaction.uncategorized ? 'Uncategorized' : (transaction.split || transaction.account || '—')}</td>
                        <td>
                          {files.length === 0 ? (
                            <span className={styles.noLinkedFile}>No linked file</span>
                          ) : (
                            <details className={styles.activityFileDetails}>
                              <summary>{files.length} {files.length === 1 ? 'file' : 'files'}</summary>
                              <ul>{files.map((file) => <li key={file.attachableId}>{file.fileName || `QuickBooks file ${file.attachableId}`}</li>)}</ul>
                            </details>
                          )}
                        </td>
                        <td><button type="button" className={styles.btn + ' ' + styles.btnSecondary} onClick={() => { setQuestionTransaction(transaction); setQuestionAudience('client'); setQuestionBody(transaction.uncategorized ? 'What was this transaction for, and which category should we use?' : 'Please provide the missing information or supporting context for this transaction.'); }}>{transaction.uncategorized ? 'Ask about category' : 'Ask'}</button></td>
                        <td>{qboUrl ? <a className={styles.activityQboLink} href={qboUrl} target="_blank" rel="noopener noreferrer">Open in QBO</a> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>
    );
  };

  const renderTransactionQuestionQueue = () => {
    const activeQuestions = transactionQuestions.filter((question) => question.status !== 'resolved');
    if (!activeQuestions.length && !questionNotice) return null;
    return <section className={styles.card} aria-labelledby="transaction-questions-title">
      <div className={styles.registerHeading}>
        <div><h2 id="transaction-questions-title" className={styles.cardTitle}>Questions and follow-ups</h2><p className={styles.activityDescription}>Client questions appear on the company’s no-login collection link. Accountant questions stay inside the company workspace.</p></div>
      </div>
      {questionNotice ? <p className={styles.notice} role="status">{questionNotice}</p> : null}
      <div className={styles.questionQueue}>{activeQuestions.map((question) => <article key={question.id} className={styles.questionQueueItem}>
        <div className={styles.questionQueueHeading}>
          <div><strong>{question.qbo_txn_type || 'Transaction'} {question.qbo_txn_doc_number || question.qbo_txn_id}</strong><span>{[question.qbo_txn_date, question.qbo_txn_vendor, question.qbo_txn_amount == null ? null : question.qbo_txn_amount.toLocaleString()].filter(Boolean).join(' · ')}</span></div>
          <span>{question.audience === 'client' ? 'Ask client' : 'Ask accountant'} · {question.status}</span>
        </div>
        <div className={styles.questionMessages}>{question.messages.map((message) => <p key={message.id}><strong>{message.author_role === 'firm' ? 'Team' : message.author_role === 'client' ? 'Client' : 'Accountant'}:</strong> {message.body}</p>)}</div>
        {question.audience === 'accountant' ? <div className={styles.questionReplyRow}><input value={questionReplies[question.id] || ''} maxLength={4000} onChange={(event) => setQuestionReplies((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Reply for the company team" /><button type="button" className={styles.btn + ' ' + styles.btnPrimary} disabled={questionSaving || !questionReplies[question.id]?.trim()} onClick={() => void replyToTransactionQuestion(question)}>Reply</button></div> : null}
        <button type="button" className={styles.btn + ' ' + styles.btnLink} disabled={questionSaving} onClick={() => void resolveTransactionQuestion(question)}>Mark resolved</button>
      </article>)}</div>
    </section>;
  };

  const renderOverview = () => {
    const counts = countEvidenceRegisterStates(evidenceRows);
    const attentionRows = evidenceRows.filter((row) => row.registerState === 'REVIEW_REQUIRED' || row.registerState === 'WRONG_MATCHED' || row.registerState === 'MISSING').slice(0, 6);
    const statusCards: { state: EvidenceRegisterState; label: string; helper: string }[] = [
      { state: 'MATCHED', label: 'Matched', helper: 'Ready' },
      { state: 'MISSING', label: 'Missing', helper: 'Needs a document' },
      { state: 'REVIEW_REQUIRED', label: 'Needs review', helper: 'Waiting for you' },
      { state: 'WRONG_MATCHED', label: 'Wrong match', helper: 'Needs correction' },
    ];
    return (
      <div className={styles.homeOverview}>
        <section className={styles.homeIntro}>
          <div>
            <span className={styles.homeEyebrow}>{connectionStatus === 'connected' ? 'Workspace up to date' : 'Setup required'}</span>
            <h2>{company?.CompanyInfo?.CompanyName ? `Good to see you. Here’s ${company.CompanyInfo.CompanyName}.` : 'Everything that needs your attention, in one place.'}</h2>
            <p>{financeMode ? 'Track evidence across every transaction and finish the exceptions first.' : 'See what arrived, what is missing, and what you can finish now.'}</p>
          </div>
          <button className={styles.btn + ' ' + styles.btnPrimary + ' ' + styles.btnLg} onClick={() => window.location.assign('/documents')}>Upload documents</button>
        </section>

        <section className={styles.homeConnectionStrip} aria-label="QuickBooks connection">
          <span className={connectionStatus === 'connected' ? styles.homeConnectionOnline : styles.homeConnectionOffline} />
          <strong>{connectionStatus === 'connected' ? 'QuickBooks connected' : 'QuickBooks needs connection'}</strong>
          <span>{company?.CompanyInfo?.CompanyName || 'No company selected'}</span>
          <span className={styles.homeConnectionMeta}>{workspaceActivityUpdatedAt ? `Last synced ${new Date(workspaceActivityUpdatedAt).toLocaleTimeString()}` : 'Not synced yet'}</span>
          {connectionStatus !== 'connected' ? <button className={styles.btn + ' ' + styles.btnSecondary} onClick={handleConnect}>Connect</button> : <button className={styles.btn + ' ' + styles.btnLink} onClick={() => setShowSettings(true)}>Integration settings</button>}
        </section>

        <section className={styles.homeStatusGrid} aria-label="Evidence status">
          {statusCards.map((status) => <button key={status.state} type="button" className={styles.homeStatusCard} onClick={() => { setEvidenceStateFilter(status.state); selectWorkspaceSection('evidence'); }}>
            <span>{status.label}</span><strong>{counts[status.state]}</strong><small>{status.helper}</small>
          </button>)}
        </section>

        <section className={styles.homeAttention} aria-labelledby="attention-title">
          <div className={styles.homeSectionHeading}><div><span className={styles.homeEyebrow}>PRIORITY</span><h2 id="attention-title">Needs attention</h2></div><button className={styles.btn + ' ' + styles.btnLink} onClick={() => selectWorkspaceSection('evidence')}>View all transactions</button></div>
          {evidenceLoading ? <p className={styles.activityEmpty}>Loading your workspace…</p> : attentionRows.length ? <div className={styles.homeAttentionList}>{attentionRows.map((row, index) => <button type="button" key={String(row.id ?? `${row.qboTxnId}-${index}`)} onClick={() => { setSelectedEvidenceRow(row); selectWorkspaceSection('evidence'); }}>
            <span className={`${styles.registerStatus} ${styles[`registerStatus_${row.registerState}`]}`}>{statusCards.find((status) => status.state === row.registerState)?.label}</span>
            <strong>{row.qboTxnVendor || row.qboTxnType || 'Unlinked document'}</strong>
            <span>{row.qboTxnDocNumber || row.attachmentFilename || 'No reference'}</span>
            <span>{row.qboTxnAmount == null ? '—' : row.qboTxnAmount.toLocaleString()}</span>
            <span className={styles.homeAttentionAction}>Review</span>
          </button>)}</div> : <p className={styles.activityEmpty}>{connectionStatus === 'connected' ? 'Nothing needs attention in this date range.' : 'Connect QuickBooks to load your workspace.'}</p>}
        </section>

        {renderWorkspaceActivity()}
        {renderTransactionQuestionQueue()}
      </div>
    );
  };

  const renderGenerate = () => (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{financeMode ? 'Generate evidence package' : 'Create a clear finance report'}</h2>
      <p className={styles.notice} style={{ marginBottom: 'var(--space-6)' }}>
        {financeMode
          ? 'Choose a date range. Zevidt retrieves transactions and supporting documents, matches evidence, and prepares a traceable package.'
          : 'Choose a date range. We’ll gather the transactions and files, organize what we find, and show what still needs attention.'}
      </p>

      <form className={styles.generationForm} onSubmit={(e) => { e.preventDefault(); handleGeneratePackage(); }}>
        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label htmlFor="startDate">Start Date</label>
            <input
              type="date"
              id="startDate"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={generating}
              required
            />
          </div>
          <div className={styles.formField}>
            <label htmlFor="endDate">End Date</label>
            <input
              type="date"
              id="endDate"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={generating}
              required
            />
          </div>
        </div>

        <div className={styles.formActions}>
          <button 
            type="submit" 
            className={styles.btn + ' ' + styles.btnPrimary + ' ' + styles.btnLg}
            disabled={generating || !realmId}
          >
            {generating ? (financeMode ? 'Generating…' : 'Putting it together…') : (financeMode ? 'Generate package' : 'Create report')}
          </button>
          {generationError && (
            <span className={styles.errorInline}>
              <AlertIcon /> {generationError}
            </span>
          )}
        </div>

        <p className={styles.formHint}>
          Uses existing Phase 8 pipeline via <code>POST /api/generate</code>. 
          Validates company ID, date format, and date range.
        </p>
      </form>
    </div>
  );

  const renderProgress = () => {
    if (!generating && progressStages.length === 0) return null;

    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Generation Status</h2>

        <div className={styles.statusOverview}>
          <div className={styles.currentStage}>
            <span className={styles.stageLabel}>Current Stage:</span>
            <span className={styles.stageName}>
              {currentStageIndex >= 0 && currentStageIndex < PIPELINE_STAGES.length
                ? PIPELINE_STAGES[currentStageIndex].label
                : generating ? 'Starting...' : 'Complete'}
            </span>
            {generating && <SpinnerIcon className={styles.spinner} aria-hidden={true} />}
          </div>
        </div>

        <div className={styles.stageList}>
          {PIPELINE_STAGES.map((stage, index) => {
            const progress = progressStages[index];
            const isCurrent = index === currentStageIndex && generating;
            const isCompleted = progress?.status === 'completed';
            const isFailed = progress?.status === 'failed';

            return (
              <div 
                key={stage.key} 
                className={`${styles.stageItem} ${isCurrent ? styles.current : ''} ${isCompleted ? styles.completed : ''} ${isFailed ? styles.failed : ''}`}
              >
                <div className={styles.stageIndicator}>
                  {isFailed ? (
                    <XIcon className={styles.iconFailed} aria-label="Failed" />
                  ) : isCompleted ? (
                    <CheckIcon className={styles.iconCompleted} aria-label="Completed" />
                  ) : isCurrent ? (
                    <SpinnerIcon className={styles.iconCurrent} aria-label="In progress" />
                  ) : (
                    <span className={styles.iconPending} aria-label="Pending">{index + 1}</span>
                  )}
                </div>
                <div className={styles.stageInfo}>
                  <div className={styles.stageNameRow}>
                    <span className={styles.stageTitle}>{stage.label}</span>
                    {progress && (
                      <span className={styles.stageTimestamp}>{new Date(progress.timestamp).toLocaleTimeString()}</span>
                    )}
                  </div>
                  {progress && progress.message && (
                    <div className={styles.stageMessage}>{progress.message}</div>
                  )}
                  {progress?.counts && (
                    <div className={styles.stageCounts}>
                      {Object.entries(progress.counts).map(([key, value]) => (
                        <span key={key} className={styles.countBadge}>{key}: {value}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {generationResult?.success && (
          <div className={styles.generationComplete}>
            <CheckIcon className={styles.iconCompletedLarge} aria-hidden={true} />
            <span>Generation Complete</span>
          </div>
        )}
      </div>
    );
  };

  const renderResult = () => {
    if (!generationResult?.success) return null;

    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Package Generated</h2>

        <div className={styles.resultGrid}>
          <div className={styles.resultField}>
            <label>Filename</label>
            <code className={styles.filename}>{generationResult.packageName}</code>
          </div>

          {generationResult.stats && (
            <>
              <div className={styles.resultField}>
                <label>Transactions</label>
                <span className={styles.statValue}>{generationResult.stats.transactionCount}</span>
              </div>
              <div className={styles.resultField}>
                <label>Attachables</label>
                <span className={styles.statValue}>{generationResult.stats.attachableCount}</span>
              </div>
              <div className={styles.resultField}>
                <label>Matched</label>
                <span className={styles.statValue + ' ' + styles.success}>{generationResult.stats.matchedCount}</span>
              </div>
              <div className={styles.resultField}>
                <label>Missing</label>
                <span className={styles.statValue + ' ' + styles.warning}>{generationResult.stats.missingCount}</span>
              </div>
              <div className={styles.resultField}>
                <label>Downloaded</label>
                <span className={styles.statValue + ' ' + styles.success}>{generationResult.stats.successfulDownloadCount}</span>
              </div>
              <div className={styles.resultField}>
                <label>Failed</label>
                <span className={styles.statValue + ' ' + styles.danger}>{generationResult.stats.failedDownloadCount}</span>
              </div>
              <div className={styles.resultField}>
                <label>ZIP Size</label>
                <span className={styles.statValue}>{formatBytes(generationResult.stats.zipSizeBytes)}</span>
              </div>
              <div className={styles.resultField}>
                <label>Runtime</label>
                <span className={styles.statValue}>{formatDuration(generationResult.stats.elapsedTimeMs)}</span>
              </div>
            </>
          )}
        </div>

        <div className={styles.cardActions}>
          <button 
            className={styles.btn + ' ' + styles.btnPrimary + ' ' + styles.btnLg}
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? 'Downloading...' : 'Download Package'}
          </button>
          {downloadError && (
            <span className={styles.downloadError}>
              <AlertIcon /> Error: {downloadError}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderContentSummary = () => {
    if (!generationResult?.success || !generationResult.stats) return null;

    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Package Contents</h2>
        <ul className={styles.contentList}>
          <li className={styles.contentItem}>
            <span className={styles.contentIcon}><CheckIcon /></span>
            <span className={styles.contentName}>evidence_register.csv</span>
            <span className={styles.contentCount}>{generationResult.stats.matchedCount} records</span>
          </li>
          <li className={styles.contentItem}>
            <span className={styles.contentIcon}><CheckIcon /></span>
            <span className={styles.contentName}>missing_documents.csv</span>
            <span className={styles.contentCount}>{generationResult.stats.missingCount} records</span>
          </li>
          <li className={styles.contentItem}>
            <span className={styles.contentIcon}><CheckIcon /></span>
            <span className={styles.contentName}>Attachments</span>
            <span className={styles.contentCount}>
              {generationResult.stats.successfulDownloadCount} files
              {generationResult.stats.failedDownloadCount > 0 && (
                <span className={styles.failedCount}>({generationResult.stats.failedDownloadCount} failed)</span>
              )}
            </span>
          </li>
        </ul>
      </div>
    );
  };

  const renderEvidence = () => {
    const counts = countEvidenceRegisterStates(evidenceRows);
    const visibleRows = filterAndSortEvidenceRegister(evidenceRows, evidenceStateFilter, evidenceSearch, evidenceSort);
    const stateLabels: Record<EvidenceRegisterState, string> = {
      MATCHED: financeMode ? 'Matched' : 'Looks right',
      MISSING: financeMode ? 'Missing' : 'No document yet',
      REVIEW_REQUIRED: financeMode ? 'Review required' : 'Needs a look',
      WRONG_MATCHED: financeMode ? 'Wrong match' : 'Possibly linked to the wrong item',
    };

    return (
      <section className={styles.card} aria-labelledby="evidence-register-title">
        <div className={styles.registerHeading}>
          <div>
            <h2 id="evidence-register-title" className={styles.cardTitle}>{financeMode ? 'Evidence register' : 'Documents & transactions'}</h2>
            <p className={styles.activityDescription}>{financeMode ? 'See what is matched, missing, or needs a decision.' : 'Find each transaction, its documents, and anything that needs a closer look.'}</p>
          </div>
          {connectionStatus === 'connected' ? <button type="button" className={styles.btn + ' ' + styles.btnSecondary} onClick={() => void loadEvidenceRegister()} disabled={evidenceLoading}>{evidenceLoading ? 'Loading…' : 'Refresh'}</button> : null}
        </div>

        <form className={styles.registerControls} onSubmit={(event) => { event.preventDefault(); void loadEvidenceRegister(); }}>
          <label><span>From</span><input type="date" value={registerStartDate} onChange={(event) => setRegisterStartDate(event.target.value)} required /></label>
          <label><span>To</span><input type="date" value={registerEndDate} onChange={(event) => setRegisterEndDate(event.target.value)} required /></label>
          <label className={styles.registerSearch}><span>Search</span><input type="search" value={evidenceSearch} onChange={(event) => setEvidenceSearch(event.target.value)} placeholder="Transaction, vendor, number, or file" /></label>
          <label><span>Status</span><select value={evidenceStateFilter} onChange={(event) => setEvidenceStateFilter(event.target.value as EvidenceRegisterState | 'ALL')}>
            <option value="ALL">All statuses</option>
            {(['MATCHED', 'MISSING', 'REVIEW_REQUIRED', 'WRONG_MATCHED'] as const).map((state) => <option key={state} value={state}>{stateLabels[state]}</option>)}
          </select></label>
          <label><span>Sort by</span><select value={evidenceSort} onChange={(event) => setEvidenceSort(event.target.value as EvidenceRegisterSort)}>
            <option value="date_desc">Newest date</option><option value="date_asc">Oldest date</option><option value="amount_desc">Highest amount</option><option value="vendor_asc">Name A–Z</option>
          </select></label>
          <button type="submit" className={styles.btn + ' ' + styles.btnPrimary} disabled={connectionStatus !== 'connected' || evidenceLoading || !realmId}>{evidenceLoading ? 'Loading…' : 'Load register'}</button>
        </form>

        {connectionStatus !== 'connected' ? <p className={styles.activityEmpty}>Connect QuickBooks to load this company’s evidence register.</p> : null}
        {evidenceError ? <p className={styles.activityError} role="alert">{evidenceError}</p> : null}

        {evidenceRows.length > 0 ? (
          <>
            <div className={styles.registerStateCounts} aria-label="Evidence register totals">
              {(['MATCHED', 'MISSING', 'REVIEW_REQUIRED', 'WRONG_MATCHED'] as const).map((state) => (
                <button type="button" key={state} className={evidenceStateFilter === state ? styles.registerCountActive : styles.registerCount} onClick={() => setEvidenceStateFilter(evidenceStateFilter === state ? 'ALL' : state)} aria-pressed={evidenceStateFilter === state}>
                  <strong>{counts[state]}</strong><span>{stateLabels[state]}</span>
                </button>
              ))}
            </div>
            <p className={styles.activitySummary} role="status">Showing {visibleRows.length} of {evidenceRows.length} register rows</p>
            {selectedEvidenceRowIds.size > 0 ? <div className={styles.cardActions}>
              <strong>{selectedEvidenceRowIds.size} selected</strong>
              <button type="button" className={styles.btn + ' ' + styles.btnPrimary} onClick={() => downloadCsvFile(`Zevidt-evidence-register-${new Date().toISOString().slice(0, 10)}.csv`, ['Date', 'Status', 'Transaction type', 'Number', 'Name', 'Amount', 'Evidence', 'QBO ID'], visibleRows.filter((row, index) => selectedEvidenceRowIds.has(evidenceSelectionKey(row, index))).map((row) => [row.qboTxnDate, stateLabels[row.registerState], row.qboTxnType, row.qboTxnDocNumber, row.qboTxnVendor, row.qboTxnAmount, row.attachmentFilename, row.qboTxnId ?? row.attachedQboTxnId]))}>Export selected CSV</button>
              <button type="button" className={styles.btn + ' ' + styles.btnLink} onClick={() => setSelectedEvidenceRowIds(new Set())}>Clear</button>
            </div> : null}
            {visibleRows.length ? (
              <div className={styles.activityTableWrap}>
                <table className={styles.registerTable}>
                  <thead><tr><th><input type="checkbox" aria-label="Select all visible register rows" checked={visibleRows.length > 0 && visibleRows.every((row, index) => selectedEvidenceRowIds.has(evidenceSelectionKey(row, index)))} onChange={() => setSelectedEvidenceRowIds((current) => { const next = new Set(current); const allSelected = visibleRows.every((row, index) => next.has(evidenceSelectionKey(row, index))); visibleRows.forEach((row, index) => { const key = evidenceSelectionKey(row, index); allSelected ? next.delete(key) : next.add(key); }); return next; })} /></th><th>Date</th><th>Status</th><th>Transaction</th><th>Number</th><th>Name</th><th>Amount</th><th>Evidence</th><th>QuickBooks</th></tr></thead>
                  <tbody>{visibleRows.map((row, index) => {
                    const qboUrl = buildQboTransactionUrl(row.qboTxnType ?? null, row.qboTxnId ?? row.attachedQboTxnId ?? null);
                    const selectionKey = evidenceSelectionKey(row, index);
                    return <tr key={selectionKey} className={styles.registerRow} onClick={() => setSelectedEvidenceRow(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedEvidenceRow(row); }}>
                      <td><input type="checkbox" aria-label={`Select register row ${row.qboTxnDocNumber || row.qboTxnId || index + 1}`} checked={selectedEvidenceRowIds.has(selectionKey)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedEvidenceRowIds((current) => { const next = new Set(current); next.has(selectionKey) ? next.delete(selectionKey) : next.add(selectionKey); return next; })} /></td>
                      <td>{row.qboTxnDate || '—'}</td>
                      <td><span className={`${styles.registerStatus} ${styles[`registerStatus_${row.registerState}`]}`}>{stateLabels[row.registerState]}</span></td>
                      <td>{row.qboTxnType || (row.qboTxnId ? 'Transaction' : 'Unlinked document')}</td>
                      <td>{row.qboTxnDocNumber || '—'}</td>
                      <td>{row.qboTxnVendor || '—'}</td>
                      <td>{row.qboTxnAmount == null ? '—' : `${company?.CompanyInfo?.Currency ? `${company.CompanyInfo.Currency} ` : ''}${row.qboTxnAmount.toLocaleString()}`}</td>
                      <td>{row.attachmentFilename || 'No document'}</td>
                      <td>{qboUrl ? <a className={styles.activityQboLink} href={qboUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>Open transaction</a> : '—'}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            ) : <p className={styles.activityEmpty}>No rows match these filters.</p>}
            {selectedEvidenceRow ? <aside className={styles.evidenceDrawer} aria-label="Transaction details">
              <div className={styles.evidenceDrawerHeader}><div><span className={styles.homeEyebrow}>TRANSACTION DETAILS</span><h3>{selectedEvidenceRow.qboTxnVendor || selectedEvidenceRow.qboTxnType || 'Evidence item'}</h3></div><button type="button" className={styles.btn + ' ' + styles.btnGhost} aria-label="Close details" onClick={() => setSelectedEvidenceRow(null)}>×</button></div>
              <dl><div><dt>Status</dt><dd><span className={`${styles.registerStatus} ${styles[`registerStatus_${selectedEvidenceRow.registerState}`]}`}>{stateLabels[selectedEvidenceRow.registerState]}</span></dd></div><div><dt>Transaction</dt><dd>{selectedEvidenceRow.qboTxnType || '—'} {selectedEvidenceRow.qboTxnDocNumber || ''}</dd></div><div><dt>Date</dt><dd>{selectedEvidenceRow.qboTxnDate || '—'}</dd></div><div><dt>Amount</dt><dd>{selectedEvidenceRow.qboTxnAmount == null ? '—' : selectedEvidenceRow.qboTxnAmount.toLocaleString()}</dd></div><div><dt>Evidence</dt><dd>{selectedEvidenceRow.attachmentFilename || 'No document attached'}</dd></div></dl>
              <div className={styles.evidenceDrawerActions}><button type="button" className={styles.btn + ' ' + styles.btnPrimary} onClick={() => window.location.assign('/documents')}>Upload document</button>{buildQboTransactionUrl(selectedEvidenceRow.qboTxnType ?? null, selectedEvidenceRow.qboTxnId ?? selectedEvidenceRow.attachedQboTxnId ?? null) ? <a className={styles.btn + ' ' + styles.btnSecondary} href={buildQboTransactionUrl(selectedEvidenceRow.qboTxnType ?? null, selectedEvidenceRow.qboTxnId ?? selectedEvidenceRow.attachedQboTxnId ?? null) ?? '#'} target="_blank" rel="noopener noreferrer">Open in QuickBooks</a> : null}</div>
            </aside> : null}
          </>
        ) : !evidenceLoading && connectionStatus === 'connected' && !evidenceError ? <p className={styles.activityEmpty}>Choose a date range and load the register.</p> : null}
      </section>
    );
  };

  const renderEvidenceRequirements = () => {
    const statusLabel: Record<RequirementEvaluation['status'], string> = {
      satisfied: 'Satisfied',
      missing: 'Missing',
      review_required: 'Needs review',
      unknown: 'Unknown',
      not_applicable: 'Not applicable',
      not_configured: 'No rules configured',
    };

    return (
      <>
        <section className={styles.card} aria-labelledby="evidence-rules-title">
          <div className={styles.registerHeading}>
            <div>
              <h2 id="evidence-rules-title" className={styles.cardTitle}>Evidence rules</h2>
              <p className={styles.activityDescription}>Set the documents your team expects for selected transaction types and amount ranges. Zevidt does not add default accounting requirements.</p>
            </div>
            <button type="button" className={styles.btn + ' ' + styles.btnSecondary} onClick={() => void loadEvidenceRules()} disabled={requirementsLoading}>
              {requirementsLoading ? 'Loading…' : 'Refresh rules'}
            </button>
          </div>
          {authStatus !== 'signed_in' && <p className={styles.activityWarning}>Sign in to view or manage this company’s evidence rules.</p>}
          {requirementsError && <p className={styles.activityError} role="alert">{requirementsError}</p>}
          {requirementsNotice && <p className={styles.activityEmpty} role="status">{requirementsNotice}</p>}

          <form className={styles.requirementForm} onSubmit={createEvidenceRule}>
            <label><span>Rule name</span><input value={ruleName} onChange={(event) => setRuleName(event.target.value)} maxLength={120} required placeholder="Example: Large vendor bill" /></label>
            <label><span>Transaction type</span><input value={ruleTransactionType} onChange={(event) => setRuleTransactionType(event.target.value)} pattern="[A-Za-z][A-Za-z0-9]{0,63}" required placeholder="Bill" /></label>
            <label><span>Minimum amount (optional)</span><input type="number" min="0" step="0.01" value={ruleAmountMin} onChange={(event) => setRuleAmountMin(event.target.value)} /></label>
            <label><span>Maximum amount (optional)</span><input type="number" min="0" step="0.01" value={ruleAmountMax} onChange={(event) => setRuleAmountMax(event.target.value)} /></label>
            <label><span>Document type</span><input value={ruleDocumentType} onChange={(event) => setRuleDocumentType(event.target.value)} pattern="[A-Za-z0-9]+([ _-][A-Za-z0-9]+)*" required placeholder="invoice" /></label>
            <button type="submit" className={styles.btn + ' ' + styles.btnPrimary} disabled={requirementsSaving || authStatus !== 'signed_in'}>{requirementsSaving ? 'Saving…' : 'Add rule'}</button>
          </form>

          {requirementRules.length === 0 && !requirementsLoading ? (
            <p className={styles.activityEmpty}>No rules yet. Add a rule only when your team has decided what it expects.</p>
          ) : (
            <div className={styles.requirementList}>
              {requirementRules.map((rule) => (
                <article className={styles.requirementItem} key={rule.id}>
                  <div>
                    <strong>{rule.name}</strong>
                    <span>{rule.transaction_type} · {rule.document_type} · {rule.amount_min ?? 'Any'} to {rule.amount_max ?? 'Any'}</span>
                  </div>
                  <button type="button" className={styles.btn + ' ' + styles.btnSecondary} onClick={() => void toggleEvidenceRule(rule)} disabled={authStatus !== 'signed_in'} aria-pressed={rule.is_active}>
                    {rule.is_active ? 'Active — turn off' : 'Inactive — turn on'}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="requirement-check-title">
          <div className={styles.registerHeading}>
            <div>
              <h2 id="requirement-check-title" className={styles.cardTitle}>Check transactions</h2>
              <p className={styles.activityDescription}>Evaluate saved rules against the cached evidence register and document classifications. This does not fetch from QuickBooks or change transaction data.</p>
            </div>
          </div>
          <div className={styles.requirementEvaluate}>
            <label><span>From</span><input type="date" value={registerStartDate} onChange={(event) => setRegisterStartDate(event.target.value)} /></label>
            <label><span>To</span><input type="date" value={registerEndDate} onChange={(event) => setRegisterEndDate(event.target.value)} /></label>
            <button type="button" className={styles.btn + ' ' + styles.btnPrimary} onClick={() => void evaluateEvidenceRules()} disabled={requirementsLoading || authStatus !== 'signed_in'}>{requirementsLoading ? 'Checking…' : 'Evaluate rules'}</button>
          </div>
          {requirementRows.length > 0 && <div className={styles.requirementResults}>
            {requirementRows.map((row) => (
              <article className={styles.requirementItem} key={row.transaction.txnId}>
                <div>
                  <strong>{row.transaction.docNumber || row.transaction.txnId} · {row.transaction.vendor || row.transaction.txnType || 'Transaction'}</strong>
                  <span>{row.transaction.date || 'Date unavailable'} · {row.transaction.amount === null ? 'Amount unavailable' : row.transaction.amount.toLocaleString()}</span>
                  {row.checks.map((check) => <span key={check.ruleId}>{check.ruleName}: {statusLabel[check.status as RequirementEvaluation['status']]} ({check.evidenceCount} qualifying file{check.evidenceCount === 1 ? '' : 's'})</span>)}
                </div>
                <span className={styles.requirementStatus}>{statusLabel[row.status]}</span>
              </article>
            ))}
          </div>}
        </section>
      </>
    );
  };

  const [missingTransactions, setMissingTransactions] = useState<RegisterEntry[]>([]);
  const [fetchingMissing, setFetchingMissing] = useState(false);

  const fetchMissingTransactions = useCallback(async () => {
    if (!generationResult?.success || !realmId) return;
    
    setFetchingMissing(true);
    try {
      const res = await fetch(`/api/evidence/register?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
      if (res.ok) {
        const register = await res.json();
        const missing = register.filter((r: any) => r.hasAttachment === false && r.txnId);
        setMissingTransactions(missing);
      }
    } catch (e) {
      console.error('Failed to fetch missing transactions:', e);
    } finally {
      setFetchingMissing(false);
    }
  }, [generationResult?.success, realmId, startDate, endDate]);

  // Fetch missing transactions when generation completes
  useEffect(() => {
    if (generationResult?.success) {
      fetchMissingTransactions();
    }
  }, [fetchMissingTransactions]);

  const renderMissing = () => {

    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>{financeMode ? 'Missing documents' : 'What’s still missing'}</h2>

        {generationResult?.success && generationResult.stats && generationResult.stats.missingCount > 0 ? (
          <>
            <div className={styles.notice}>
              <p>The missing documents report is included in the generated package as <code>missing_documents.csv</code>.</p>
              <p>Total missing: <strong>{generationResult.stats.missingCount}</strong></p>
              <p>Fields included:</p>
              <ul className={styles.fieldList}>
                <li><strong>Date</strong> — Transaction date</li>
                <li><strong>Transaction Type</strong> — Type of transaction</li>
                <li><strong>Doc Number</strong> — Document/reference number</li>
                <li><strong>Vendor/Customer</strong> — Counterparty name</li>
                <li><strong>Amount</strong> — Transaction amount</li>
                <li><strong>Missing Since</strong> — Date the transaction was created (no attachment)</li>
              </ul>
              <p className={styles.noticeHint}>Download the package to access the full missing documents report.</p>
            </div>

            {/* Collection Request Section */}
            <div className={styles.inboxSection}>
              <h3 className={styles.inboxSectionTitle}>
                <MissingIcon style={{ marginRight: 'var(--space-2)', verticalAlign: 'middle' }} />
                Create Collection Request
              </h3>
              <p className={styles.inboxSectionDesc}>
                Select one or more missing transactions to request documents from your client. 
                A permanent inbox link will be created for this company.
              </p>

              {/* Transaction Selection Table */}
              {missingTransactions.length > 0 && (
                <div className={styles.selectionTable}>
                  <div className={styles.tableHeader}>
                    <label className={styles.selectAllLabel}>
                      <input
                        type="checkbox"
                        checked={selectedTxnIds.length === missingTransactions.length && missingTransactions.length > 0}
                        onChange={(e) => handleSelectAll(missingTransactions.map((t: any) => t.txnId), e.target.checked)}
                        disabled={creatingRequest}
                      />
                      Select All ({missingTransactions.length})
                    </label>
                  </div>
                  <div className={styles.tableRows}>
{missingTransactions.map((txn: any) => {
                      const qboUrl = buildQboTransactionUrl(txn.txnType ?? null, txn.txnId ?? null);
                      return (
                        <label key={txn.txnId} className={styles.txnRow} style={{ cursor: qboUrl ? 'pointer' : 'default' }} onClick={(e) => {
                          // Don't navigate if clicking on checkbox
                          if (e.target instanceof HTMLInputElement && e.target.type === 'checkbox') return;
                          if (qboUrl) {
                            window.open(qboUrl, '_blank', 'noopener,noreferrer');
                          }
                        }}>
                          <input
                            type="checkbox"
                            checked={selectedTxnIds.includes(txn.txnId)}
                            onChange={(e) => handleTxnSelect(txn.txnId, e.target.checked)}
                            disabled={creatingRequest}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className={styles.txnInfo}>
                            <span className={styles.txnType}>{txn.txnType}</span>
                            <span className={styles.txnDocNumber}>{txn.docNumber}</span>
                            <span className={styles.txnDate}>{txn.date}</span>
                            <span className={styles.txnVendor}>{txn.vendor}</span>
                            <span className={styles.txnAmount}>{txn.amount}</span>
                          </div>
                          {qboUrl && (
                            <span className={styles.qboLinkHint} title="Opens in QuickBooks Online">
                              <LinkIcon style={{ width: 14, height: 14, verticalAlign: 'middle' }} />
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className={styles.inboxActions}>
                {inboxToken ? (
                  <div className={styles.inboxLinkCreated}>
                    <div className={styles.linkDisplay}>
                      <LinkIcon style={{ marginRight: 'var(--space-2)', verticalAlign: 'middle' }} />
                      <code className={styles.linkCode}>
                        {window.location.origin}/inbox/{inboxToken}
                      </code>
                    </div>
                    <button
                      className={styles.btn + ' ' + styles.btnSecondary}
                      onClick={handleCopyLink}
                      disabled={creatingRequest}
                    >
                      {copiedLink ? (
                        <>
                          <CheckIcon style={{ marginRight: 'var(--space-2)' }} />
                          Copied!
                        </>
                      ) : (
                        <>
                          <CopyIcon style={{ marginRight: 'var(--space-2)' }} />
                          Copy Link
                        </>
                      )}
                    </button>
                    <p className={styles.linkNote}>
                      This link is permanent for this company. Share it with your client to collect documents.
                    </p>
                  </div>
                ) : (
                  <button
                    className={styles.btn + ' ' + styles.btnPrimary + ' ' + styles.btnLg}
                    onClick={handleCreateRequest}
                    disabled={creatingRequest || selectedTxnIds.length === 0 || !realmId}
                  >
                    {creatingRequest ? (
                      <>
                        <SpinnerIcon style={{ marginRight: 'var(--space-2)' }} />
                        Creating Request...
                      </>
                    ) : (
                      <>
                        <LinkIcon style={{ marginRight: 'var(--space-2)' }} />
                        Create Request ({selectedTxnIds.length} selected)
                      </>
                    )}
                  </button>
                )}

                {requestError && (
                  <div className={styles.requestError}>
                    <AlertIcon /> {requestError}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : generationResult?.success ? (
          <div className={styles.notice + ' ' + styles.success}>
            <CheckIcon style={{ marginRight: 'var(--space-2)', verticalAlign: 'middle' }} />
            No missing documents found for this period.
          </div>
        ) : (
          <p className={styles.notGenerated}>Generate a package to view missing document details.</p>
        )}
      </div>
    );
  };

  const renderAttachments = () => (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{financeMode ? 'Attachments' : 'Files in your package'}</h2>

      {generationResult?.success && generationResult.stats ? (
        <>
          <div className={styles.attachmentStats}>
            <div className={styles.statBox}>
              <span className={styles.statNumber}>{generationResult.stats.matchedCount}</span>
              <span className={styles.statLabel}>Total Attachments</span>
            </div>
            <div className={styles.statBox + ' ' + styles.success}>
              <span className={styles.statNumber}>{generationResult.stats.successfulDownloadCount}</span>
              <span className={styles.statLabel}>Successful Downloads</span>
            </div>
            <div className={styles.statBox + ' ' + styles.danger}>
              <span className={styles.statNumber}>{generationResult.stats.failedDownloadCount}</span>
              <span className={styles.statLabel}>Failed Downloads</span>
            </div>
          </div>
          <p className={styles.attachmentHint}>
            Attachments are downloaded during package generation using the existing Phase 5/10 pipeline.
            Failed downloads are retried with 5-second backoff (Phase 10B). Individual attachment download
            is not exposed separately; all attachments are included in the package ZIP.
          </p>
        </>
      ) : (
        <p className={styles.notGenerated}>Generate a package to view attachment status.</p>
      )}
    </div>
  );

  const renderSettings = () => (
    <div className={styles.modalOverlay} onClick={() => setShowSettings(false)}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>Settings</h3>
          <button className={styles.modalClose} onClick={() => setShowSettings(false)} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className={styles.modalBody}>
          <section className={styles.settingsSection}>
            <h4>QuickBooks Connection</h4>
            <dl className={styles.settingsList}>
              <dt>Connected Company</dt>
              <dd>{company?.CompanyInfo?.CompanyName || 'Not connected'}</dd>
              <dt>Connection Status</dt>
              <dd>
                <span className={`status-${connectionStatus}`}>
                  {connectionStatus === 'connected' ? 'Connected' : 
                   connectionStatus === 'error' ? 'Error' : 
                   connectionStatus === 'checking' ? 'Checking...' : 'Not Connected'}
                </span>
              </dd>
              <dt>Realm ID</dt>
              <dd><code>{realmId || '—'}</code></dd>
            </dl>
          </section>

          <section className={styles.settingsSection}>
            <h4>Package Configuration</h4>
            <dl className={styles.settingsList}>
              <dt>Selected Date Range</dt>
              <dd>{startDate} to {endDate}</dd>
              <dt>Date Range Valid</dt>
              <dd>{validateDates() ? 'No' : 'Yes'}</dd>
            </dl>
          </section>

          <section className={styles.settingsSection}>
            <h4>Retry & Rate Limit Behavior (System)</h4>
            <dl className={styles.settingsList}>
              <dt>API 429 Retry</dt>
              <dd>Enabled — 60-second production backoff (Phase 10A)</dd>
              <dt>Attachment Connection Retry</dt>
              <dd>Enabled — 5-second backoff, 3 attempts (Phase 10B)</dd>
              <dt>Retry Location</dt>
              <dd>Backend only (Phase 8 pipeline)</dd>
            </dl>
          </section>

          <section className={styles.settingsSection}>
            <h4>Authentication Status</h4>
            <dl className={styles.settingsList}>
              <dt>Token Status</dt>
              <dd><span>{getConnectionHealth()}</span></dd>
              <dt>Token Refresh</dt>
              <dd>{getTokenRefreshStatus()}</dd>
              <dt>Expiry</dt>
              <dd>{tokenInfo ? new Date(tokenInfo.expires_at).toLocaleString() : '—'}</dd>
            </dl>
          </section>

          <p className={styles.settingsNote}>
            <strong>Note:</strong> These are informational read-only values. Retry delays, OAuth credentials,
            and token configuration are code-level settings, not user-editable preferences.
          </p>
        </div>
      </div>
    </div>
  );

  // Render active section content
  const renderActiveSection = () => {
    switch (activeSection) {
      case 'overview':
        return renderOverview();
      case 'generate':
        return (
          <>
            {renderProgress()}
            {renderGenerate()}
            {renderResult()}
            {renderContentSummary()}
          </>
        );
      case 'evidence':
        return renderEvidence();
      case 'missing':
        return renderMissing();
      case 'attachments':
        return renderAttachments();
      case 'requirements':
        return renderEvidenceRequirements();
      default:
        return renderOverview();
    }
  };

  return (
    <div className={styles.container}>
      <WorkspaceHeader
        activeSection={activeSection === 'requirements' ? undefined : activeSection}
        onSelectSection={selectWorkspaceSection}
      />
      <main className={styles.main} role="main">
        {activeSection !== 'overview' ? <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>
              {getSectionLabel(activeSection, financeMode)}
            </h1>
            <span className={styles.pageSubtitle}>{financeMode ? 'A clear view of evidence, missing documents, and review items.' : 'A clear view of what’s ready and what needs attention.'}</span>
          </div>
          <div className={styles.headerRight}>
            <div className={styles.connectionIndicator}>
              {renderHeaderConnectionBadge()}
              <span className={styles.companyName}>
                {company?.CompanyInfo?.CompanyName || 'Not connected'}
              </span>
            </div>
            <button 
              className={styles.btn + ' ' + styles.btnGhost} 
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
            >
              <SettingsIcon />
            </button>
          </div>
        </header> : null}

        {/* Connection error alert */}
        {connectionError && connectionStatus !== 'connected' && authStatus !== 'signed_out' && (
          <div className={styles.alert + ' ' + styles.alertError} role="alert">
            <AlertIcon />
            <strong>Connection Error:</strong> {connectionError}
            <button className={styles.btn + ' ' + styles.btnLink} onClick={handleRefreshConnection}>
              Retry
            </button>
          </div>
        )}

        {/* Active section content */}
        {renderActiveSection()}

        {/* Settings Modal */}
        {showSettings && renderSettings()}
        {questionTransaction ? <div className={styles.modalOverlay} onClick={() => setQuestionTransaction(null)}>
          <div className={styles.modal} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ask-transaction-title">
            <div className={styles.modalHeader}><h3 id="ask-transaction-title">Ask about this transaction</h3><button className={styles.modalClose} onClick={() => setQuestionTransaction(null)} aria-label="Close"><CloseIcon /></button></div>
            <div className={styles.modalBody}>
              <p className={styles.activityDescription}>{questionTransaction.txnType || 'Transaction'} {questionTransaction.docNumber || questionTransaction.txnId} · {questionTransaction.vendor || 'No name'} · {questionTransaction.amount?.toLocaleString() ?? 'No amount'}</p>
              <label className={styles.questionFormField}><span>Who should answer?</span><select value={questionAudience} onChange={(event) => setQuestionAudience(event.target.value as 'client' | 'accountant')}><option value="client">Client — show on no-login link</option><option value="accountant">Accountant — internal company queue</option></select></label>
              <label className={styles.questionFormField}><span>Question</span><textarea rows={5} maxLength={4000} value={questionBody} onChange={(event) => setQuestionBody(event.target.value)} /></label>
              <button type="button" className={styles.btn + ' ' + styles.btnPrimary} disabled={questionSaving || !questionBody.trim()} onClick={() => void createTransactionQuestion()}>{questionSaving ? 'Saving…' : questionAudience === 'client' ? 'Add to client link' : 'Ask accountant'}</button>
            </div>
          </div>
        </div> : null}
      </main>
    </div>
  );
}
