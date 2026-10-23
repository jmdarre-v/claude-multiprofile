// Sharing chat history between Claude Code profiles.
//
// Claude Code keeps its history in the profile's config folder: the `projects` folder (one
// transcript per session) and `history.jsonl` (the prompt history). Sharing links those two
// entries from the new profile to the source profile, so both see the same history.
// The source keeps its files. A copy that the new profile already had is moved aside, never deleted.

import fs from "node:fs";
import path from "node:path";

export const SHARED_HISTORY = ["projects", "history.jsonl"];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Links the history of `toDir` to `fromDir`. Returns one line per entry, for the user.
export function linkHistory(fromDir, toDir) {
  const notes = [];
  fs.mkdirSync(fromDir, { recursive: true });
  fs.mkdirSync(toDir, { recursive: true });
  for (const item of SHARED_HISTORY) {
    const src = path.join(fromDir, item);
    const dst = path.join(toDir, item);
    const isDir = item === "projects";
    if (!fs.existsSync(src)) {
      if (isDir) fs.mkdirSync(src);
      else fs.writeFileSync(src, "");
    }
    let existing = null;
    try {
      existing = fs.lstatSync(dst);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink() && fs.readlinkSync(dst) === src) {
        notes.push(`${item}: already shared`);
        continue;
      }
      const backup = `${dst}.before-sharing-${stamp()}`;
      fs.renameSync(dst, backup);
      notes.push(`${item}: the old copy was kept as ${backup}`);
    }
    fs.symlinkSync(src, dst, isDir ? "dir" : "file");
    notes.push(`${item}: shared with ${fromDir}`);
  }
  return notes;
}
