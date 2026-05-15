// Shared atomic-write utility for v2 layer writers (P2 from external review,
// v2.7.1+). Honors the README architecture invariant:
//
//   "All write paths use atomic write (temp + rename)."
//
// On POSIX, rename(2) is atomic on the same filesystem — readers either see
// the old content or the new content, never a torn/half-written file. The
// fsync between write and rename forces the data to durable storage so a
// hard crash after rename leaves a consistent file (not just a directory
// entry pointing at unflushed data).
//
// Use this in every place that previously called writeFileSync(path, content)
// on a markdown record file. Caller still owns mkdirSync for the target dir.

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, basename } from "node:path";

export function atomicWriteFile(path: string, content: string): void {
  // Same-directory temp file ensures the rename stays on one filesystem.
  // PID + monotonic timestamp avoids tmp collisions if two processes race.
  const tmp = `${dirname(path)}/.${basename(path)}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8", flag: "w" });
  // fsync the tmp file before renaming — without this, a crash between
  // rename and disk flush can leave a zero-length file under the real name.
  let fd = -1;
  try {
    fd = openSync(tmp, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== -1) closeSync(fd);
  }
  renameSync(tmp, path);
}
