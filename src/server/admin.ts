// The admin surface (D17): kill switch, rotation, incident, ledger, users,
// health. Never meta-tools — a model must not be able to unfreeze the vault.
// One route table serves both /admin/api/* (remote, MFA-gated in http.ts) and the
// CLI acting on the state dir (local), so both paths share one set of input rules
// and every call lands in the ledger either way.
import { createHash } from "node:crypto";
import type { Principal, SecretScope } from "../contracts.js";
import type { App, RotationGroup } from "./app.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Body = Record<string, unknown>;
type Handler = (app: App, by: Principal, params: Record<string, string>, q: URLSearchParams, body: Body) => unknown;

// Ids end up in state files and vault paths: no separators, no leading underscore.
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const who = (p: Principal) => `${p.org}/${p.user}`;

const ROUTES: Array<[string, Handler]> = [
  ["GET ledger", (a, _by, _p, q) => {
    const limit = num(q.get("limit") ?? "100", "limit", 1, 10_000);
    return a.ledger.all({ user: q.get("user") || undefined, server: q.get("server") || undefined, since: time(q.get("since")) }).slice(-limit);
  }],
  ["GET ledger/verify", (a) => a.verifyLedger()],
  ["GET ledger/flagged", (a) => a.ledger.flagged()],
  ["GET kill", (a) => a.kill.status()],
  ["POST kill/all", (a, by) => a.kill.revokeAll(who(by))],
  ["POST kill/server/:id", (a, by, p) => a.kill.revokeServer(p.id, who(by))],
  ["POST kill/user/:org/:user", (a, by, p) => a.kill.revokeUser(p.user, p.org, who(by))],
  ["POST enable/server/:id", (a, by, p) => a.kill.enableServer(p.id, who(by))],
  ["POST enable/user/:org/:user", (a, by, p) => a.kill.enableUser(p.user, p.org, who(by))],
  ["POST lockdown/end", (a, by) => a.kill.endLockdown(who(by))],
  ["GET rotation/due", (a) => a.rotation.due()],
  ["POST rotate", (a, _by, _p, _q, b) => {
    if (b.all === true) return a.rotation.rotateAll();
    if (b.group !== undefined) return a.rotation.rotateGroup(group(b.group));
    if (b.scope !== undefined) return a.rotation.rotate(scope(b.scope));
    throw new HttpError(400, 'body needs { scope }, { group } or { all: true }');
  }],
  ["POST incident", (a, by, _p, _q, b) => a.rotation.incident({ since: time(b.since), user: id(b.user, "user", true), server: id(b.server, "server", true), by: who(by) })],
  ["GET users", (a) => a.users.list()],
  ["POST users", async (a, _by, _p, _q, b) => {
    const u = a.users.add(id(b.id, "id")!, id(b.org, "org")!, b.admin === true);
    return u.admin ? { ...u, totpUri: await a.enrollTotp({ user: u.id, org: u.org, admin: true }) } : u;
  }],
  ["DELETE users/:id", async (a, _by, p) => {
    const u = a.users.get(p.id);
    if (!u) throw new HttpError(404, `unknown user ${p.id}`);
    a.users.remove(p.id);
    // Every cell goes (credentials and TOTP), so a later user with the same org/id inherits nothing.
    const cells = await a.store.list({ org: u.org, user: u.id }).catch(() => []); // best effort while frozen
    for (const c of cells) await a.store.delete(c.scope).catch(() => false);
    await a.store.delete({ org: u.org, user: u.id, server: "_totp" }).catch(() => false);
    return { removed: p.id, credentials: cells.filter((c) => c.scope.server !== "_totp").length };
  }],
  ["POST users/:id/token", (a, _by, p) => {
    if (!a.users.get(p.id)) throw new HttpError(404, `unknown user ${p.id}`);
    return a.users.issueToken(p.id);
  }],
  // One leaked token, not the whole user: ids come from `GET users` (hashes never leave users.json).
  ["DELETE users/:id/token/:tokenId", (a, _by, p) => {
    if (!a.users.get(p.id) || !a.users.revokeToken(p.id, p.tokenId)) throw new HttpError(404, `unknown token ${p.tokenId} for user ${p.id}`);
    return { revoked: p.tokenId };
  }],
  ["GET health", (a, by, _p, q) => {
    const ids = q.get("ids") ? q.get("ids")!.split(",").filter(Boolean) : a.registry.manifests().map((m) => m.id);
    for (const i of ids) if (!a.registry.manifest(i)) throw new HttpError(404, `unknown server ${i}`);
    return Promise.all(ids.map((i) => a.registry.health(by, i)));
  }],
];

/** Run one admin call as `by`. Throws HttpError for bad input / unknown routes. */
export async function adminCall(app: App, by: Principal, method: string, path: string, q = new URLSearchParams(), body: Body = {}): Promise<unknown> {
  let segs: string[];
  try {
    segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "malformed path");
  }
  let match: { name: string; handler: Handler; params: Record<string, string> } | undefined;
  for (const [route, handler] of ROUTES) {
    const [m, pattern] = route.split(" ");
    const parts = pattern.split("/");
    if (m !== method || parts.length !== segs.length) continue;
    const params: Record<string, string> = {};
    if (parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = segs[i]), true) : p === segs[i]))) {
      match = { name: parts.filter((p) => !p.startsWith(":")).join("."), handler, params };
      break;
    }
  }
  if (!match) throw new HttpError(404, `no admin route ${method} ${path}`);
  for (const [k, v] of Object.entries(match.params)) if (!ID.test(v)) throw new HttpError(400, `invalid ${k}`);

  const tool = `admin.${match.name}`;
  const target = match.params.id ?? (match.params.org ? `${match.params.org}/${match.params.user}` : undefined);
  try {
    const out = await match.handler(app, by, match.params, q, body ?? {});
    app.ledger.record({ ts: Date.now(), org: by.org, user: by.user, server: "_admin", tool, result: "authorized", reason: target });
    return out ?? { ok: true };
  } catch (err) {
    app.ledger.record({ ts: Date.now(), org: by.org, user: by.user, server: "_admin", tool, result: "error", reason: app.scrub((err as Error).message) });
    throw err;
  }
}

function num(v: string, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer in ${min}..${max}`);
  return n;
}

/** ISO date or epoch ms; absent → undefined. */
function time(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  if (!Number.isFinite(t)) throw new HttpError(400, "since must be an ISO date or epoch ms");
  return t;
}

function id(v: unknown, name: string, optional = false): string | undefined {
  if (optional && (v === undefined || v === null || v === "")) return undefined;
  if (typeof v !== "string" || !ID.test(v)) throw new HttpError(400, `${name} must be an id (letters, digits, . _ -)`);
  return v;
}

function scope(v: unknown): SecretScope {
  const s = (v ?? {}) as Body;
  return { org: id(s.org, "scope.org")!, user: id(s.user, "scope.user")!, server: id(s.server, "scope.server")! };
}

function group(v: unknown): RotationGroup {
  const g = (v ?? {}) as Body;
  const out: RotationGroup = { server: id(g.server, "group.server", true), category: id(g.category, "group.category", true), org: id(g.org, "group.org", true), user: id(g.user, "group.user", true) };
  if (!Object.values(out).some(Boolean)) throw new HttpError(400, "group needs at least one of server, category, org, user");
  return out;
}

// --- the admin page ------------------------------------------------------------
// One self-contained page, no external assets. Token and TOTP code live in JS
// memory only (never storage); every row is rendered with textContent because
// ledger fields carry caller-supplied strings.

const STYLE = `body{font:14px/1.4 system-ui,sans-serif;margin:0 auto;max-width:72rem;padding:1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input,button{color:inherit;background:#222;border-color:#555}}
section{border:1px solid #8884;border-radius:6px;padding:.75rem 1rem;margin:1rem 0}h2{margin:.2rem 0 .6rem;font-size:1.05rem}
form{display:flex;gap:.5rem;flex-wrap:wrap;margin:.4rem 0}input{padding:.3rem;border:1px solid #8888;border-radius:4px}
button{padding:.3rem .7rem;border:1px solid #8888;border-radius:4px;cursor:pointer}.danger{border-color:#c33;color:#c33}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #8883;padding:.2rem .4rem;text-align:left}
tr.flag{background:#c331}pre{white-space:pre-wrap;font-size:12px;max-height:20rem;overflow:auto}#msg{color:#c33}`;

const SCRIPT = `let tok="",code="",sess="";const $=id=>document.getElementById(id);
async function api(m,p,b){const h={authorization:"Bearer "+tok};if(sess)h["x-osmcp-admin-session"]=sess;else h["x-osmcp-totp"]=code;if(b)h["content-type"]="application/json";
const r=await fetch("/admin/api/"+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});sess=r.headers.get("x-osmcp-admin-session")||sess;const d=await r.json().catch(()=>({}));
if(r.status===401){sess="";$("ui").hidden=true;$("login").hidden=false;}if(!r.ok)throw new Error(d.error||r.statusText);return d;}
const show=x=>{$("out").textContent=JSON.stringify(x,null,2);$("msg").textContent="";};const fail=e=>{$("msg").textContent=e.message;};
function table(el,rows,cols){el.replaceChildren();const hr=el.insertRow();for(const c of cols){const th=document.createElement("th");th.textContent=c;hr.append(th);}
for(const r of rows){const tr=el.insertRow();if(r.flagged)tr.className="flag";for(const c of cols){const v=c==="ts"?new Date(r.ts).toISOString():r[c]===undefined?"":typeof r[c]==="object"?JSON.stringify(r[c]):String(r[c]);tr.insertCell().textContent=v;}}}
async function refresh(){$("kill").textContent=JSON.stringify(await api("GET","kill"),null,2);const f=new FormData($("lf"));const q=new URLSearchParams();
for(const k of ["user","server"])if(f.get(k))q.set(k,f.get(k));q.set("limit","200");table($("ledger"),(await api("GET","ledger?"+q)).reverse(),["ts","org","user","server","tool","result","reason","flagged"]);}
const run=async(fn,ask)=>{if(ask&&!confirm(ask))return;try{show(await fn());await refresh();}catch(e){fail(e);}};
$("login").onsubmit=async e=>{e.preventDefault();tok=$("tok").value;code=$("totp").value;$("totp").value="";try{await refresh();$("login").hidden=true;$("ui").hidden=false;$("msg").textContent="";}catch(err){fail(err);}};
for(const f of document.querySelectorAll("form[data-act]"))f.onsubmit=e=>{e.preventDefault();const d=new FormData(f);
run(()=>api("POST",f.dataset.act.replace(/\\{(\\w+)\\}/g,(_,k)=>encodeURIComponent(d.get(k)))),f.dataset.ask);};
for(const b of document.querySelectorAll("button[data-post]"))b.onclick=()=>run(()=>api("POST",b.dataset.post),b.dataset.ask);
$("lf").onsubmit=e=>{e.preventDefault();refresh().catch(fail);};$("verify").onclick=()=>api("GET","ledger/verify").then(show,fail);
$("flagged").onclick=()=>api("GET","ledger/flagged").then(r=>table($("ledger"),r,["ts","org","user","server","tool","result","reason"]),fail);
$("due").onclick=()=>api("GET","rotation/due").then(r=>table($("duet"),Array.isArray(r)?r.map(x=>({...x.scope,...x})):[],["org","user","server","kind","rotatedAt"]),fail);
const val=(f,k)=>new FormData($(f)).get(k)||undefined;
$("r1").onsubmit=e=>{e.preventDefault();run(()=>api("POST","rotate",{scope:{org:val("r1","org"),user:val("r1","user"),server:val("r1","server")}}));};
$("rg").onsubmit=e=>{e.preventDefault();run(()=>api("POST","rotate",{group:{server:val("rg","server"),category:val("rg","category")}}));};
$("ra").onclick=()=>run(()=>api("POST","rotate",{all:true}),"Rotate every credential?");
$("inc").onsubmit=e=>{e.preventDefault();run(()=>api("POST","incident",{since:val("inc","since"),user:val("inc","user"),server:val("inc","server")}),"Start the incident flow? This revokes everything and rotates the affected credentials.");};`;

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
export const ADMIN_CSP = `default-src 'none'; script-src ${sha(SCRIPT)}; style-src ${sha(STYLE)}; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;

export const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>one-stop-mcp admin</title><style>${STYLE}</style></head><body>
<h1>one-stop-mcp admin</h1>
<form id="login"><label>Admin token <input id="tok" type="password" autocomplete="off" required></label>
<label>TOTP code <input id="totp" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required></label><button>Unlock</button></form>
<p id="msg" role="status"></p>
<main id="ui" hidden>
<section><h2>Kill switch</h2><pre id="kill"></pre>
<button class="danger" data-post="kill/all" data-ask="Revoke ALL? Every session is cut and the vault freezes.">Revoke all</button>
<button data-post="lockdown/end" data-ask="End the lockdown for every server?">End lockdown</button>
<form data-act="kill/server/{id}" data-ask="Revoke this server?"><input name="id" placeholder="server id" required><button class="danger">Revoke server</button></form>
<form data-act="enable/server/{id}"><input name="id" placeholder="server id" required><button>Re-enable server</button></form>
<form data-act="kill/user/{org}/{user}" data-ask="Revoke this user?"><input name="org" placeholder="org" required><input name="user" placeholder="user" required><button class="danger">Revoke user</button></form>
<form data-act="enable/user/{org}/{user}"><input name="org" placeholder="org" required><input name="user" placeholder="user" required><button>Re-enable user</button></form>
</section>
<section><h2>Rotation</h2><button id="due">Show due</button><table id="duet"></table>
<form id="r1"><input name="org" placeholder="org" required><input name="user" placeholder="user" required><input name="server" placeholder="server" required><button>Rotate one</button></form>
<form id="rg"><input name="server" placeholder="server"><input name="category" placeholder="category"><button>Rotate group</button></form>
<button class="danger" id="ra">Rotate all</button></section>
<section><h2>Incident</h2><form id="inc"><input name="since" placeholder="since (ISO)"><input name="user" placeholder="user"><input name="server" placeholder="server"><button class="danger">After a scare: revoke + rotate</button></form></section>
<section><h2>Ledger</h2><form id="lf"><input name="user" placeholder="user"><input name="server" placeholder="server"><button>Filter</button>
<button type="button" id="flagged">Flagged only</button><button type="button" id="verify">Verify chain</button></form><table id="ledger"></table></section>
<section><h2>Result</h2><pre id="out"></pre></section>
</main><script>${SCRIPT}</script></body></html>`;
