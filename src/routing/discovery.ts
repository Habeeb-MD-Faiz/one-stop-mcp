// find_tools' fallback ladder (PDR §4.2), behind the Discovery contract:
//   1. exact  — the query names a tool (`create_issue`, `github/create_issue`,
//               `GitHub.Create-Issue`): that tool first.
//   2. hybrid — RRF over the retrieval legs (lexical + BM25, + dense when a local
//               embedder is loaded).
//   3. widen  — when the legs disagree, return 2k hits and the categories they fall
//               in, so the model can browse with list_servers(category) instead of
//               trusting a guess.
// Hits keep their full inputSchema; the caller compresses.

import type { Discovery, DiscoveryResult } from "../contracts.js";
import { Bm25Router, LexicalRouter, rrfFuse, type RoutableTool, type Router, type ScoredTool } from "./router.js";

const MAX_K = 50;
const BROWSE = 3; // categories suggested on low confidence
const EXACT_SCORE = 1; // above any RRF score (at most legs/31), so exact hits sort first

export class HybridDiscovery implements Discovery {
  private warned = new Set<Router>();

  constructor(readonly legs: Router[] = [new LexicalRouter(), new Bm25Router()]) {}

  async discover(query: string, tools: RoutableTool[], k: number): Promise<DiscoveryResult> {
    k = Math.min(Math.max(Math.floor(k) || 1, 1), MAX_K);
    // Each leg returns a deeper pool than k so fusion can rescue a tool one leg
    // ranks just outside the cut, and so widening to 2k has candidates.
    const pool = Math.max(k * 4, 20);
    const lists = await Promise.all(this.legs.map((leg) => leg.rank(query, tools, pool).catch((err) => this.legFailed(leg, err))));
    let hits = rrfFuse(lists);

    const q = nameKey(query);
    const exact = q ? tools.filter((t) => nameKey(t.tool) === q || nameKey(t.server + t.tool) === q) : [];
    if (exact.length) {
      const ids = new Set(exact.map(id));
      hits = [...exact.map((t) => ({ ...t, score: EXACT_SCORE })), ...hits.filter((h) => !ids.has(id(h)))];
    }

    // A bare name shared by several servers (`search`) is not an identification.
    if (exact.length === 1 || agree(hits[0], lists)) return { hits: hits.slice(0, k), confidence: "high", widened: false };
    const wide = hits.slice(0, 2 * k);
    return { hits: wide, confidence: "low", widened: true, browse: browse(wide.length ? wide : tools) };
  }

  // A broken leg (say the embedder runs out of memory) degrades find_tools to the
  // remaining legs instead of failing it. Logged once per leg, not per query.
  private legFailed(leg: Router, err: unknown): ScoredTool[] {
    if (!this.warned.has(leg)) {
      this.warned.add(leg);
      process.stderr.write(`one-stop-mcp: routing leg ${leg.constructor.name} failed, continuing without it: ${(err as Error)?.message ?? err}\n`);
    }
    return [];
  }
}

/** Confidence from leg agreement: high when every leg that returned anything puts
 *  the fused top hit in its own top 3. RRF already rewards agreement in the score,
 *  but its scores have no absolute scale, so a margin threshold would need tuning
 *  per catalog size; agreement is scale-free. The legs are diverse retrievers
 *  (term overlap, IDF-weighted terms, meaning), so when they converge on one tool
 *  it is rarely wrong, and when they split the query is ambiguous or synonym-heavy
 *  — exactly when a wider list beats a confident guess. Calibrated on the bench:
 *  `npm run bench` prints top-3 accuracy for the high and low buckets. */
export function agree(top: ScoredTool | undefined, lists: ScoredTool[][]): boolean {
  if (!top) return false;
  const voting = lists.filter((l) => l.length);
  return voting.length > 0 && voting.every((l) => l.slice(0, 3).some((t) => id(t) === id(top)));
}

/** The categories the candidates concentrate in, weighted by fused score. With no
 *  candidates at all, the catalog's largest categories. */
function browse(tools: Array<RoutableTool & { score?: number }>): string[] {
  const weight = new Map<string, number>();
  for (const t of tools) for (const c of t.category ?? []) weight.set(c, (weight.get(c) ?? 0) + (t.score ?? 1));
  return [...weight].sort((a, b) => b[1] - a[1]).slice(0, BROWSE).map(([c]) => c);
}

/** Case- and separator-insensitive name: `GitHub/Create-Issue` -> `githubcreateissue`. */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function id(t: RoutableTool): string {
  return `${t.server}/${t.tool}`;
}
