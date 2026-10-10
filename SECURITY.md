# Security policy

One-Stop MCP holds the credentials a user connects to other services, so we take reports seriously. The design and its limits are described in [docs/security.md](docs/security.md).

> **Status.** Pre-release and not independently audited. Do not use it with production credentials yet.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it privately through GitHub: on the repository, go to **Security** → **Report a vulnerability** (or open <https://github.com/Habeeb-MD-Faiz/one-stop-mcp/security/advisories/new>). This creates a private advisory visible only to you and the maintainers.

Please include:

- what you found and the impact you believe it has;
- steps to reproduce, or a proof of concept (a failing test is ideal);
- the version or commit, the mode (local, team, Docker) and the configuration involved;
- whether you have told anyone else.

**Never include a real token, key or `OSMCP_MASTER_KEY` in a report.** Use fakes. If you accidentally exposed a real credential while testing, rotate it first.

### What to expect

This is a one-maintainer project, so these are honest best-effort targets, not guarantees:

- acknowledgement within **5 days**;
- an initial assessment (accepted, need more detail, or not a vulnerability) within **14 days**;
- a fix or a mitigation plan agreed with you, with timing depending on severity;
- credit in the advisory if you want it.

We ask for coordinated disclosure: please give us reasonable time to fix before publishing, and we will tell you when the fix is out. Good-faith research that stays within this policy, avoids other people's data, and does not degrade a service you do not own will not be pursued.

## Supported versions

There are no releases yet. Until 1.0 only the latest commit on the default branch is supported; fixes land there.

## Scope

**In scope**

- Disclosure of a stored credential: through the vault, the ledger, logs, error messages, tool results, the key-entry or admin pages, metrics, or a downstream process's environment.
- Weaknesses in the cryptography or key handling: key hierarchy, AES-GCM use, the SigV4 and Transit/KMS key providers, token and ticket generation, the ledger's hash chain and signatures.
- Breaking tenant isolation: one org or user reaching another's credentials, sessions or ledger entries.
- Authentication and authorization bypass: bearer tokens, admin API and TOTP, kill-switch and lockdown evasion (a denied call that goes through).
- The OAuth broker: state, PKCE and redirect handling, ticket reuse, open redirects, CSRF on the key-entry page.
- Injection into downstream servers' arguments or environment that the gateway should have prevented, and path or command injection in the CLI and manifest loading.
- A malicious or malformed manifest or catalog snapshot that makes the gateway run something the manifest author should not be able to cause (beyond the declared command).
- Supply-chain issues in this repository's build, CI workflows, Dockerfile or dependencies.

**Out of scope**

- Vulnerabilities in a downstream MCP server or in a provider's API. Report them to that project. (A gateway flaw that makes one *worse* is in scope.)
- A downstream server misusing the credential it was legitimately sent. It is trusted with that credential by design; choose servers accordingly.
- Attacks that need root or equivalent on the host running the gateway, or write access to its state directory.
- Missing TLS when you chose to expose the plain HTTP port; terminate TLS in front of it.
- Denial of service by an authenticated administrator, or volumetric network attacks.
- Prompt injection that only persuades a model to use access the user already granted. Mitigations are in the [threat model](docs/security.md#threat-model); the ledger and kill switch are how you notice and respond.
- Reports from automated scanners with no demonstrated impact, and social engineering.

## The threat model in brief

What the vault defends and where it stops, in four lines (the full version is in [docs/security.md](docs/security.md)):

- **Encrypted at rest.** AES-256-GCM per record, with keys derived per org and per user from one root key, and each record bound to its (org, user, server) cell. The root key comes from `OSMCP_MASTER_KEY`, a key file (local mode), or a KMS / Vault Transit-wrapped key.
- **Secrets stay out of the model.** `connect_server` returns a URL; keys are typed into the gateway's own page. Credentials are injected only into the outbound call they authenticate, and are redacted from results and errors.
- **Everything is audited and stoppable.** A hash-chained, Ed25519-signed ledger with anomaly flags; a kill switch for everything, one server or one user; rotation for one, a group or all.
- **Limits.** Pre-release, unaudited; plain HTTP unless you put TLS in front; local mode keeps the key file next to the vault; a downstream server sees the credential it is sent.

## Hardening your deployment

See the checklist in [docs/security.md](docs/security.md#hardening-checklist-for-a-team-deployment) and the deployment notes in [docs/deployment.md](docs/deployment.md).
