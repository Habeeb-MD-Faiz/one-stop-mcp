# RFC process

Design changes to One-Stop MCP go through a short, public, written process, so that the reasoning is on record and anyone can weigh in before the architecture sets. The maintainer makes the final call ([GOVERNANCE.md](../../GOVERNANCE.md)).

## Index

| RFC | Title | Status |
|---|---|---|
| [0001](0001-v1-open-questions.md) | Answers to the v1 open questions (Q1-Q9) | Accepted provisionally, open for comment |

## When you need an RFC

Write one for a change that:

- alters what the **client** sees: the meta-tools, their schemas, or the `find_tools` result shape;
- changes the **security model**: key hierarchy, vault format, ledger format or signing, kill-switch semantics, admin authentication, anything that touches how credentials are stored or injected;
- changes the **manifest format** or the config file in a way that is not purely additive;
- adds or removes a **transport**, a vault or key-management backend, or a runtime dependency that the gateway cannot do without;
- changes **governance** or this process.

You do **not** need one for: adding or fixing a server, improving routing examples, bug fixes, documentation, refactors that keep behavior, or an optional additive config field. Open an issue or a PR directly. If you are unsure, open an issue with the "RFC" template and ask.

Vulnerabilities do not go in an RFC or any public issue. Follow [SECURITY.md](../../SECURITY.md).

## Steps

1. **Float the idea (optional).** Open an issue with the RFC template, or a discussion. Two paragraphs are enough. This saves you from writing a long document for something the maintainer will reject on principle.
2. **Write it.** Copy [`0000-template.md`](0000-template.md) to `docs/rfcs/NNNN-short-title.md`, where `NNNN` is the next unused number. Fill in every section. An RFC argues from evidence: cite the source of a technical choice (a standard, a paper, vendor documentation), prefer the boring, widely adopted method, and say so when you deviate.
3. **Open a PR** containing only that file, titled `RFC: <title>`, with the `rfc` label. Set the status to `Draft`.
4. **Comment period.** When you mark the PR ready, the status becomes `In comment period` and stays there for **at least 14 days**. Anyone may comment. Substantive changes restart a shorter 7-day period on the changed parts. The author answers every substantive comment in the document itself (an "Unresolved questions" or "Changes since first draft" entry), not only in the thread.
5. **Decision.** After the period the maintainer decides: **Accepted**, **Rejected**, **Postponed**, or **Withdrawn** by the author. The decision and a short reason are written into the RFC's "Decision" section, and the PR is merged either way, because rejected RFCs are part of the record.
6. **Implementation.** Accepted RFCs are implemented in ordinary PRs that link the RFC. An RFC is not a promise that someone will build it.
7. **Changing it later.** Fix typos and clarifications by PR. A change of substance is a new RFC that supersedes the old one; the old one's status becomes `Superseded by NNNN`.

## Statuses

`Draft` · `In comment period` · `Accepted` · `Rejected` · `Postponed` · `Withdrawn` · `Superseded by NNNN`

## What a good RFC contains

- The problem, in terms of what breaks or stays impossible without the change.
- The design, specific enough that someone else could implement it.
- How it affects the design tenets, in particular **context cost**: does it add startup tokens, or anything that grows with the number of servers? If so, it is wrong by default.
- Security and failure behavior: what happens when it goes wrong, and what an attacker gains.
- Alternatives you rejected, with the trade-offs, and a clear recommendation.
- Migration: what existing users and manifests have to change.
