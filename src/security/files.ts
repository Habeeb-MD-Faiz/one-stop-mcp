import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

// The few file primitives every security state file needs: owner-only modes,
// create-once (so two processes racing to make a key both end up reading the
// same one), atomic replace (a crash never leaves a half-written vault), and a
// cheap change stamp so a long-running gateway notices edits from the CLI.
// (Modes are advisory on Windows; ACLs of the state dir do the job there.)

/** Create `path` with `data` unless it exists. True if this call wrote it. */
export function writeOnce(path: string, data: string | Buffer, mode = 0o600): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, data, { mode, flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Replace `path` atomically: write a sibling temp file, then rename over. */
export function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Changes whenever the file is replaced or rewritten; "" when it does not exist. */
export function stampOf(path: string): string {
  const st = statSync(path, { throwIfNoEntry: false });
  return st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "";
}
