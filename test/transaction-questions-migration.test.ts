import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261114001500_add_transaction_questions.sql', 'utf8');

describe('transaction questions migration contract', () => {
  it('creates company-scoped question, message, and event records without cascading deletion', () => {
    expect(sql).toContain('CREATE TABLE public.transaction_questions');
    expect(sql).toContain('CREATE TABLE public.transaction_question_messages');
    expect(sql).toContain('CREATE TABLE public.transaction_question_events');
    expect(sql).toContain('REFERENCES public.transaction_questions (realm_id, id)');
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('keeps messages and events append-only and reserves writes for trusted server operations', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.transaction_question_messages');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.transaction_question_events');
    expect(sql).toContain('BEFORE TRUNCATE ON public.transaction_question_messages');
    expect(sql).toContain('BEFORE TRUNCATE ON public.transaction_question_events');
    expect(sql).toContain('REVOKE ALL ON public.transaction_questions, public.transaction_question_messages, public.transaction_question_events');
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*\sTO authenticated/i);
  });

  it('performs create, answer, and resolve state changes atomically with immutable events', () => {
    expect(sql).toContain('CREATE FUNCTION public.create_transaction_question');
    expect(sql).toContain('CREATE FUNCTION public.answer_transaction_question');
    expect(sql).toContain('CREATE FUNCTION public.resolve_transaction_question');
    expect(sql).toContain("VALUES(p_realm_id,question_id,'created','firm',p_actor_user_id)");
    expect(sql).toContain("VALUES(p_realm_id,p_question_id,'answered',p_actor_role,p_actor_user_id,event_time)");
    expect(sql).toContain("VALUES(p_realm_id,p_question_id,'resolved','firm',p_actor_user_id,event_time)");
  });
});
