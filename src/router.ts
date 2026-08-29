// Discovery routing, behind an interface so the backend can change without the
// facade noticing. P0/P1 default: LexicalRouter — field-weighted keyword
// overlap, zero deps, fully offline. A vector/embedding router (Q3) implements
// the same interface and drops in when the catalog grows enough that lexical
// collisions start costing top-3 accuracy.

export interface RoutableTool {
  server: string;
  tool: string;
  description: string;
  examples: string[];
  category?: string[];
  inputSchema?: unknown;
}

export interface ScoredTool extends RoutableTool {
  score: number;
}

export interface Router {
  rank(query: string, tools: RoutableTool[], k: number): ScoredTool[];
}

// Field weights: what a term is worth toward the score depending on where it
// matched. A hit in the tool name is stronger evidence than one in prose.
const W_NAME = 3;
const W_EXAMPLE = 2;
const W_CATEGORY = 2;
const W_DESC = 1;

export class LexicalRouter implements Router {
  rank(query: string, tools: RoutableTool[], k: number): ScoredTool[] {
    const qTerms = [...new Set(terms(query))];
    if (qTerms.length === 0) return [];
    const qNorm = norm(query);

    const scored = tools.map((t) => {
      const weights = new Map<string, number>();
      add(weights, terms(t.tool), W_NAME);
      for (const ex of t.examples) add(weights, terms(ex), W_EXAMPLE);
      add(weights, terms((t.category ?? []).join(" ")), W_CATEGORY);
      add(weights, terms(t.description), W_DESC);

      let score = qTerms.reduce((s, term) => s + (weights.get(term) ?? 0), 0);
      // Strong signal: the query is (almost) one of the tool's example utterances.
      if (t.examples.some((ex) => norm(ex) === qNorm)) score += 10;
      return { ...t, score };
    });

    return scored.filter((t) => t.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

/** Tokenize to lowercase alphanumeric terms, splitting snake_case, kebab, and
 *  camelCase (searchRepositories -> search, repositories) so tool names match. */
export function terms(s: string): string[] {
  return (s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));
}

function norm(s: string): string {
  return terms(s).join(" ");
}

function add(map: Map<string, number>, ts: string[], weight: number): void {
  for (const t of ts) map.set(t, (map.get(t) ?? 0) + weight);
}

// A tiny stoplist — filler that would otherwise reward every tool equally.
const STOP = new Set(["the", "a", "an", "my", "me", "to", "of", "in", "on", "for", "and", "or", "is", "it", "this", "that", "with", "please", "can", "you", "i", "want", "need"]);
