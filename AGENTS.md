 # AGENTS.md
 
 When executing any task:
 
 - Assume Windows 11 PowerShell.
 - Never use Linux or macOS commands.
 - Never use `curl`. Always use `curl.exe`.
 - Use only commands compatible with Windows PowerShell.
 - Implement only the requested task.
 - Modify only the files required for the task.
 - If another file is required, stop and ask first.
 - Read only the files required for the current task.
 - Do not scan the repository unless explicitly requested.
 - Verify every implementation before reporting completion.
 - Treat terminal output as the source of truth.
 - Never claim success without runtime verification.
 - Never claim a bug is fixed unless verification passes.
 - Resolve one bug at a time.
 - Follow this workflow: Find → Fix → Verify.
 - If verification fails, continue debugging the same bug until it passes.
 - Do not start another task while the current verification is failing.
 - Verify modified files using `git status` before reporting them.
 - Do not commit unless explicitly instructed.
 - Keep responses minimal.
 - If asked for one command, output one command only.
 - If asked for a prompt, output only the prompt.
 - If you do not have enough evidence, say so instead of guessing.
## Zevidt project safeguards

- Work only in the current Zevidt repository. The original AuditReady project is protected: never access or modify it.
- Never change the existing `.env.local` file or the Supabase CLI project link.
- Never expose, print, commit, or otherwise disclose credentials, access tokens, or secrets.
- Preserve all existing uncommitted work. Do not reset, revert, overwrite, or discard it.
- Do not commit, push, or deploy without explicit authorization.
- Before destructive database operations, migrations against a remote database, or changes to financial data, stop and obtain explicit approval. Do not change QuickBooks financial fields.
- During a read-only investigation, do not modify files, databases, credentials, policies, or external services.
- Report PASS only when runtime evidence supports it. Label code inspection, mocked tests, local tests, and live integration results separately.
- For implementation, use Find → Fix → Verify and handle one bug at a time. If verification fails, continue on that issue only.
