## What and why

<!-- One or two sentences. Link the issue or RFC if there is one. -->

## Type

- [ ] New server (manifest + snapshot + bench queries)
- [ ] Routing: new utterances
- [ ] Core change
- [ ] Docs
- [ ] RFC (a file in `docs/rfcs/` only)

## Checklist for every PR

- [ ] `npm run typecheck`, `npm test` and `npm run validate` pass locally
- [ ] No secret, token or `.env` file is committed
- [ ] The commit message says what changed (`servers: add notion`, `routing: ...`)

## Checklist for a new or changed server

- [ ] `servers/<id>.yaml`: `id` is lowercase-kebab and equals the file name
- [ ] The comment at the top of the manifest names the source I checked (URL) and says whether it is official, reference or community
- [ ] npx / uvx packages are pinned to an exact version
- [ ] `auth` is correct: `keyUrl` for `api_key`, `env` or `header` set where needed, and no real credential anywhere in the file
- [ ] `routing.examples` has 3-5 natural-language requests; `routing.tools` covers the most-used tools
- [ ] `catalog/<id>.json` has real tool names and descriptions (`source` is `live` or `docs`)
- [ ] `bench/seed/<id>.jsonl` has 4 queries that do not copy the manifest's examples
- [ ] `npm run validate` is green and the `npm run bench` top-3 figure did not drop
- [ ] I ran `npm run probe -- <id>`, or the server needs credentials to start and I say so below

## Checklist for routing changes

- [ ] `npm run bench` before: ___ top-3, after: ___ top-3

## Checklist for security-relevant changes

- [ ] If this touches `src/security/`, `src/auth/` or the admin API: there is a test for the failure path, not only the happy path
- [ ] No secret value can reach a log line, an error message or a tool result

## Notes for the reviewer

<!-- Anything unusual: a server that cannot be probed, a trade-off, a follow-up. -->
