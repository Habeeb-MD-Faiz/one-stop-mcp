# RFC 0002: Agent audit trail (sessions and approvals in the ledger)

| | |
|---|---|
| **Status** | Draft |
| **Author(s)** | @Habeeb-MD-Faiz |
| **Created** | 2026-10-13 |
| **Comment period ends** | not started (the PR is not open yet) |
| **Supersedes / superseded by** | none |

## Summary

Extend the usage ledger beyond single MCP calls so that one tamper-evident log answers "what did an AI agent do, when, as whom, and who allowed it", whichever agent client made the call. Two new entry kinds: a **session** entry (client, account, model, working directory, session id, a pointer to the client's own transcript) and a **decision** entry (an action was allowed or denied, by which authority: a rule, an automated judge or a human, and whether it then ran). Existing call entries gain an optional `session` field that links them to their session.

## Motivation

The person running several agent clients (Claude Code, Codex, Gemini CLI and others) on one machine or across a team has no single place to reconstruct an incident. Each client keeps its own transcript in its own format; policy hooks keep their own logs; human approvals of a prompted action are only in the transcript. After something goes wrong the questions are always the same: when did it happen, which agent and account did it, who allowed it, how do we fix it and make sure it cannot happen again. The ledger already answers part of this for MCP calls that pass through the gateway, with tamper evidence. It does not know which session a call belongs to, and it cannot record a decision made outside the gateway.

## Design

Sketch only; to be made precise before the comment period.

- **Session entry** (`kind: "session"`): `session`, `client` (e.g. `claude-code`), `account`, `model`, `cwd`, `transcript` (a path or URI, never the content), `started`, `ended`.
- **Decision entry** (`kind: "decision"`): `session`, `action` (tool name plus a short, redacted summary of its input), `decision` (`allow` / `deny` / `ask`), `by` (`rule:<id>` / `judge:<model>` / `human:<user>`), `ran` (true / false / unknown), `reason`.
- **Call entries:** optional `session` field. Absent for clients that do not send one; nothing else changes.
- **How entries arrive:** the gateway writes session entries for its own MCP sessions. Client hooks that run outside the gateway (pre-tool policy hooks, session start/end hooks) post session and decision entries through one admin-authenticated endpoint, so every source ends up in the same signed chain.
- **Query:** `one-stop-mcp ledger trace --session <id>` and `ledger trace --path <glob>` ("what touched X, and who allowed it").

### Effect on the design tenets

- **Context cost.** None. Nothing is added to the client face; logging happens in hooks and the gateway.
- **Spec compliance.** Unchanged. The session id is gateway metadata, not an MCP extension.
- **One vault.** Unchanged. Entries carry pointers and redacted summaries, never credentials or full payloads.
- **One-file contribution.** Unchanged.

### Security and failure behavior

Decision summaries are the main leak risk: a command line can contain a secret. They go through the existing redaction plus a length cap. Full request and response bodies are never stored; the client's transcript stays the source of detail. If the ledger is unreachable, a hook must not block the agent; it falls back to a local append-only file that is imported later (an open question).

## Alternatives considered

- **Full request/response capture.** Answers more questions, but duplicates every transcript, grows without bound and stores whatever secrets passed through. Rejected.
- **A separate log per client, merged at query time.** No new format, but no tamper evidence and no single timeline. It is what exists today, and it is the gap.
- **An external observability stack (OpenTelemetry traces).** Mature tooling, but a heavy dependency for a single user, and spans are not signed. Possible later as an export target.

## Recommendation

Session and decision entries in the existing signed ledger, with pointers to transcripts instead of copies.

## Sources

- The ledger design in [security.md](../security.md#usage-ledger) (D19).
- OpenTelemetry semantic conventions for GenAI (https://opentelemetry.io/docs/specs/semconv/gen-ai/) as a reference for field names.

## Migration

Additive. Old entries stay valid; `ledger verify` accepts the new kinds.

## Unresolved questions

- Should hooks outside the gateway sign their own entries, or must everything go through the gateway's key?
- What is the offline fallback when the gateway is down, and how is it re-imported without breaking the chain?
- Should the judge's model and prompt version be part of `by`?

## Changes since first draft

- (none yet)

## Decision

*Filled in by the maintainer after the comment period.*

- **Outcome:** Accepted / Rejected / Postponed
- **Date:** YYYY-MM-DD
- **Reason:** one or two sentences
