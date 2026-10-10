# Governance

How decisions are made in One-Stop MCP. Short on purpose: the project is young, and heavy process with no community to govern would be theatre.

> **Status.** The repository is private. This document records the governance model chosen in the build session of 2026-10-10 ([D12](docs/burndown/DECISIONS.md), [RFC 0001, Q9](docs/rfcs/0001-v1-open-questions.md#q9-governance-bdfl-core-team-consensus-or-foundation-d12-sticky)). It takes effect when the maintainer makes the repository public.

## Model: BDFL plus maintainers

- **Benevolent Dictator For Life (BDFL):** Habeeb ([@Habeeb-MD-Faiz](https://github.com/Habeeb-MD-Faiz)). Has the final say on direction, RFCs, releases, and who is a maintainer.
- **Maintainers:** people with merge rights who review and merge pull requests. Listed in [`.github/CODEOWNERS`](.github/CODEOWNERS). Today the BDFL is the only one.
- **Contributors:** anyone who files an issue, comments on an RFC, or sends a PR.

A BDFL model is the fastest route to a coherent v1, and with no outside maintainers yet there is no one for consensus to mean anything. The RFC process keeps every design decision written down and open to comment, so a change of model later does not mean reconstructing why things are the way they are.

The BDFL commits to: explain decisions in writing when asked, use the RFC process for design changes rather than deciding in private, and follow the [Code of Conduct](CODE_OF_CONDUCT.md) like everyone else.

## Day-to-day decisions

| Change | Who decides |
|---|---|
| Add or fix a server manifest, routing examples, docs | One maintainer approval, with CI green. |
| Bug fix, refactor, small feature that fits the existing design | One maintainer approval, with CI green. |
| Anything in `src/security/`, `src/auth/` or the admin API | The BDFL reviews (enforced by CODEOWNERS). |
| Adding a runtime dependency | The BDFL approves, with a stated reason. |
| Design change (meta-tools, security model, manifest format, transports, governance) | The RFC process below. |

If a maintainer and a contributor disagree and cannot settle it, the BDFL decides. Reviews should say what would make a change mergeable, not only that it is not.

## The RFC process

Design changes go through written RFCs in [`docs/rfcs/`](docs/rfcs/README.md):

1. Copy the template to `docs/rfcs/NNNN-short-title.md` (numbers are sequential) and open a pull request.
2. A **comment period of at least 14 days** follows, during which anyone can comment. The author answers substantive objections in the document.
3. The **BDFL decides**: accepted, rejected or postponed. The reason is written into the RFC and the PR is merged either way.
4. Implementation is ordinary PRs that link the RFC.

Security vulnerabilities are not RFC material; see [SECURITY.md](SECURITY.md).

## Becoming a maintainer

There is no fixed quota. The usual path:

1. A sustained record of good contributions over **at least three months**: merged PRs that needed little rework, review of other people's PRs, and answers to questions in issues.
2. Familiarity with the design tenets and the parts of the code you would review. Security-sensitive areas are the last to be delegated.
3. **Nomination by an existing maintainer** (or self-nomination by issue), and **approval by the BDFL**. The invitation is public, with the reasons.

Maintainers are asked to review in good faith, respond within a reasonable time, and step back honestly when they cannot. A maintainer with no activity for six months is moved to "emeritus" after a message asking whether they want to stay. The BDFL may remove a maintainer for Code of Conduct violations or for abusing merge rights; the reason is recorded in a public issue unless it would harm a person.

## Conflicts of interest

A maintainer whose employer sells a competing gateway, or who maintains a server being added to the catalog, says so in the PR and does not make the final call on that change alone. Vendors may contribute manifests for their own servers; the same review standards apply.

## Releases

- **Before 1.0**: no fixed cadence. The BDFL cuts a release when there is a coherent set of changes worth shipping, and says what it contains and what it breaks.
- **From 1.0**: semantic versioning. Minor releases roughly monthly if there are changes; patch releases as needed, immediately for security fixes. Catalog updates (servers, snapshots, routing examples) may ship between releases.
- Releases are cut manually by a maintainer. The `release.yml` workflow only builds artifacts; publishing is a deliberate human step.

## When this model changes

BDFL governance is meant to be revisited, not kept forever. Open an RFC to propose a foundation or a core-team model when **any** of these is true:

- there are **three or more regular maintainers** who are not the BDFL and do not share an employer with the BDFL;
- **two or more organizations** run the gateway in production and ask for a neutral home;
- the BDFL is, or expects to become, unable to maintain the project.

If the BDFL becomes unavailable and has named no successor, the active maintainers choose one by consensus and record it in a PR to this file.

## Amending this document

Changes to GOVERNANCE.md go through the RFC process.
