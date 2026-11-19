'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
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
    <main className="min-h-screen bg-[#f7f8f6] px-6 py-12 text-[#17231f]">
      <section className="mx-auto w-full max-w-md">
        <Link href="/quickbooks" className="workspaceBrand mx-auto mb-10 w-fit">
          <span className="workspaceBrandMark" aria-hidden="true">z</span><span>zevidt</span>
        </Link>
        <div className="rounded-[22px] border border-[#e2e7e3] bg-white p-8 shadow-[0_18px_55px_rgba(28,48,37,.08)] sm:p-10">
        <p className="text-sm font-semibold text-[#176b52]">Welcome back</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-.045em]">Sign in to your workspace</h1>
        <p className="mt-2 text-sm leading-6 text-[#6c7973]">Use the account set up for your Zevidt workspace.</p>
        <form onSubmit={handleSubmit} className="mt-7 grid gap-5">
          <label className="grid gap-2 text-sm font-medium">
            Email
            <input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="h-11 rounded-md border border-[#c8ced8] px-3" />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Password
            <input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} className="h-11 rounded-md border border-[#c8ced8] px-3" />
          </label>
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <button disabled={loading} className="h-12 rounded-xl bg-[#176b52] px-4 font-semibold text-white transition hover:bg-[#10513e] disabled:opacity-60">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        </div>
      </section>
    </main>
  );
}
