// Verifies the P0 exit criterion: the gateway's startup surface stays under the
// 2k-token target. The startup surface is exactly the tools/list payload the
// client sees — the four meta-tools — and nothing else, at any catalog size.
//
// Run: npm run budget   (exits non-zero if the budget is blown)
import { META_TOOLS } from "../src/meta-tools.js";

const BUDGET = 2000;

// ponytail: chars/4 is the standard rough token estimate; swap for a real
// tokenizer if the margin ever gets tight. It won't for four small tools.
const payload = JSON.stringify({ tools: META_TOOLS });
const estTokens = Math.ceil(payload.length / 4);

console.log(`startup surface: ${META_TOOLS.length} meta-tools, ${payload.length} chars, ~${estTokens} tokens (budget ${BUDGET}).`);

if (estTokens > BUDGET) {
  console.error(`OVER BUDGET by ~${estTokens - BUDGET} tokens.`);
  process.exit(1);
}
console.log(`under budget by ~${BUDGET - estTokens} tokens.`);
