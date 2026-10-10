# RFC NNNN: Title

| | |
|---|---|
| **Status** | Draft |
| **Author(s)** | @github-handle |
| **Created** | YYYY-MM-DD |
| **Comment period ends** | YYYY-MM-DD (at least 14 days after the PR is marked ready) |
| **Supersedes / superseded by** | none |

## Summary

One paragraph. What is being changed, in plain words.

## Motivation

What problem does this solve, and who has it? What breaks or stays impossible without the change? Link issues, benchmarks or incidents.

## Design

The proposal, specific enough that another contributor could implement it. Include interfaces, config or manifest fields, wire formats and error behavior. Diagrams are welcome.

### Effect on the design tenets

- **Context cost.** Does this add startup tokens to the client, or anything that grows with the number of registered servers? (If yes, justify it or change the design.)
- **Spec compliance.** Does it stay inside the MCP specification on both faces?
- **One vault.** Does it change where or how credentials are stored, used or exposed?
- **One-file contribution.** Does it make adding a server harder?

### Security and failure behavior

What can an attacker do with this, and what happens when it fails? Which credentials, if any, does it touch?

## Alternatives considered

For each option: what it is, why it is better or worse than the others (concrete trade-offs, not just names), and why you did not choose it.

## Recommendation

Which option you propose and why, in a few sentences.

## Sources

Standards, papers, vendor documentation or measurements the design rests on (title and link). Say so explicitly if you are relying on less established work.

## Migration

What existing users, configs and manifests must change, and how they find out.

## Unresolved questions

What you do not know yet. Move items to "Changes since first draft" as they are settled during the comment period.

## Changes since first draft

- (none yet)

## Decision

*Filled in by the maintainer after the comment period.*

- **Outcome:** Accepted / Rejected / Postponed
- **Date:** YYYY-MM-DD
- **Reason:** one or two sentences
