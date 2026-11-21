'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { ZevidtLogo } from '@/app/quickbooks/icons';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'request' | 'update'>('login');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (query.has('error') || query.has('error_code') || fragment.has('error') || fragment.has('error_code')) {
      setMode('request');
      setError('This recovery link is invalid or expired. Request a new link below.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    const { data } = supabaseBrowser.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setMode('update');
        setError(null);
        setNotice(null);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (mode === 'request') {
        const { error: recoveryError } = await supabaseBrowser.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/login`,
        });
        if (recoveryError) throw recoveryError;
        setNotice('If this email has an account, a password reset link will arrive shortly.');
        return;
      }
      if (mode === 'update') {
        const { error: updateError } = await supabaseBrowser.auth.updateUser({ password });
        if (updateError) throw updateError;
        setPassword('');
        setNotice('Your password has been updated. You can open your workspace.');
        return;
      }
      const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      router.replace('/quickbooks');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-[#f4f4f2] text-[#171717] lg:grid-cols-[minmax(0,1.08fr)_minmax(440px,.92fr)]">
      <section className="relative hidden overflow-hidden bg-[#111827] p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        <Link href="/quickbooks" className="workspaceBrand w-fit !text-white">
          <ZevidtLogo inverse />
        </Link>
        <div className="relative z-10 max-w-2xl">
          <p className="mb-6 text-xs font-semibold uppercase tracking-[.2em] text-white/45">Evidence, under control</p>
          <h1 className="text-[clamp(3.6rem,6vw,6.8rem)] font-medium leading-[.88] tracking-[-.08em]">Every transaction.<br />Clearly supported.</h1>
          <p className="mt-8 max-w-lg text-lg leading-8 text-white/55">Collect documents, resolve uncertainty, and build a verifiable record without the usual chase.</p>
        </div>
        <p className="relative z-10 text-xs text-white/35">QuickBooks connected · Human verified · Audit ready</p>
        <div className="pointer-events-none absolute -right-48 top-1/4 size-[42rem] rounded-full bg-[#3e6ae1]/20 blur-3xl" />
      </section>
      <section className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-12">
        <div className="w-full max-w-md">
        <Link href="/quickbooks" className="workspaceBrand mb-14 w-fit lg:hidden">
          <ZevidtLogo />
        </Link>
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#858580]">Secure workspace</p>
        <h1 className="mt-4 text-4xl font-medium leading-tight tracking-[-.06em]">{mode === 'request' ? 'Reset your password' : mode === 'update' ? 'Choose a new password' : 'Welcome back.'}</h1>
        <p className="mt-3 text-base leading-7 text-[#70706b]">{mode === 'login' ? 'Sign in to continue to your Zevidt workspace.' : 'Use the email connected to your Zevidt account.'}</p>
        <form onSubmit={handleSubmit} className="mt-10 grid gap-5">
          {mode !== 'update' ? <label className="grid gap-2 text-sm font-medium">
            Email
            <input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="h-12 rounded-lg border border-[#cecec8] bg-white px-4 outline-none transition focus:border-[#3e6ae1] focus:ring-4 focus:ring-blue-100" />
          </label> : null}
          {mode !== 'request' ? <label className="grid gap-2 text-sm font-medium">
            Password
            <input autoComplete={mode === 'update' ? 'new-password' : 'current-password'} type="password" required value={password} onChange={(event) => setPassword(event.target.value)} className="h-12 rounded-lg border border-[#cecec8] bg-white px-4 outline-none transition focus:border-[#3e6ae1] focus:ring-4 focus:ring-blue-100" />
          </label> : null}
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          {notice ? <p role="status" className="text-sm text-[#24694d]">{notice}</p> : null}
          <button disabled={loading} className="h-12 rounded-lg bg-[#3e6ae1] px-5 font-semibold text-white shadow-[0_6px_18px_rgba(62,106,225,.24)] transition hover:bg-[#3159c9] disabled:opacity-60">
            {loading ? 'Please wait…' : mode === 'request' ? 'Send reset link' : mode === 'update' ? 'Update password' : 'Sign in'}
          </button>
        </form>
        {mode === 'update' && notice ? <Link href="/quickbooks" className="mt-5 block text-sm font-semibold text-[#171717] underline underline-offset-4">Open workspace</Link> : null}
        {mode !== 'update' ? <button type="button" disabled={loading} onClick={() => { setMode(mode === 'login' ? 'request' : 'login'); setError(null); setNotice(null); setPassword(''); }} className="mt-5 text-sm font-semibold text-[#555550] underline decoration-[#c2c2bc] underline-offset-4 hover:text-black">{mode === 'login' ? 'Forgot password?' : 'Back to sign in'}</button> : null}
        </div>
      </section>
    </main>
  );
}
