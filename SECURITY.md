# Security Policy

Omakase is **pre-1.0** software. It orchestrates autonomous agents that read,
write, and execute code in the workspaces you point it at — treat it like any
tool that runs untrusted-ish automation on your machine, and don't aim it at
anything precious.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability. Use GitHub's [private vulnerability reporting][advisory] on this
repository, or open a minimal issue asking a maintainer to contact you privately
(don't include details there).

[advisory]: https://github.com/benis-me/Omakase/security/advisories/new

We'll acknowledge your report, investigate, and coordinate a fix and disclosure
with you. Thank you for helping keep the project and its users safe.

## Scope & expectations

- **Autonomous execution is the point.** Agents run with the autonomy level you
  set and the file/tool access of the CLIs you've installed. Review what a run
  did before trusting its output, and use the autonomy dial deliberately.
- **Secrets.** Don't commit credentials. `.env` files, `*.db` stores, and `.omks`
  runtime data are git-ignored; agent prompts/outputs are persisted locally under
  a workspace's `.omks/omks.db`.
- **No formal support window yet.** Until 1.0, security fixes land on `main`.
