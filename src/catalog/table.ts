// Plain-text table for the CLI scripts (validate, probe). Columns padded to the widest cell.
export function formatTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  return all.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join("  ")).join("\n");
}
