# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in SoulForge, please report it responsibly.

**Do not open a public issue.** Instead, email [security@proxysoul.com](mailto:security@proxysoul.com) with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

The following are in scope for security reports:

- **File access controls** — bypassing forbidden file enforcement or outside-cwd protections
- **Shell injection** — crafting inputs that execute unintended shell commands
- **Secret exposure** — API keys, tokens, or credentials leaking through tool output, logs, or session files
- **Session/memory tampering** — corrupting or reading another user's session data
- **Dependency vulnerabilities** — critical CVEs in direct dependencies

## Security Architecture

SoulForge implements several layers of protection:

- **Forbidden file enforcement** — blocks access to sensitive files (.env, credentials, private keys) across all tools. Input checks (pre-execution) on read_file, edit_file, navigate, analyze, refactor, rename_symbol, move_symbol, editor. Output filtering (post-execution) on grep, glob, soul_grep, soul_find. Manage patterns via `/privacy` command.
- **Outside-CWD confirmation** — write operations targeting files outside the project directory require explicit user approval
- **Shell anti-patterns** — blocks cat|grep|find pipes, redirects to built-in tools. Detects subshell expansion referencing sensitive keywords (env, pem, key, credentials, secrets, token, passwd, ssh, aws)
- **Pre-commit checks** — auto-runs lint + typecheck before allowing `git commit` via shell tool. Catches issues the agent introduced before they're committed.
- **Secret storage** — API keys stored in OS keychain (macOS) or 0o600-permissioned files, never in config
- **Session file permissions** — session data written with restrictive file modes (0o600)
- **No telemetry** — SoulForge does not phone home or collect usage data

### Managing Forbidden Patterns

Use `/privacy` to add or remove forbidden file patterns:

- **Project scope** — patterns in `.soulforge/forbidden` apply to current project
- **Global scope** — patterns in `~/.soulforge/forbidden` apply everywhere
- Built-in patterns cover `.env`, `.pem`, `credentials`, `private_key`, `id_rsa`, `.npmrc`, `.netrc`, `shadow`, `passwd`, and more
