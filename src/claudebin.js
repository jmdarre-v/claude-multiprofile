// Resolve the `claude` binary the same way the user's shell would.
//
// This tool deliberately shares ONE system-wide `claude` (and one Claude
// Desktop) across every profile — isolation is by config/data dir, not by
// duplicating the binary. That design has a sharp edge: if the user has more
// than one `claude` on their PATH (multiple Node versions via nvm, a Homebrew
// copy shadowing an npm copy, a half-removed global install), the one that
// "wins" can silently change, and every profile rides on whichever that is.
//
// Surfacing the winning binary and its version in `list`, `status`, and
// `doctor` turns that invisible failure mode into something you can see at a
// glance.

import { execFileSync } from "node:child_process";

// Locate every `claude` on PATH, in resolution order. We shell out to the
// login shell's `which -a` rather than re-implementing PATH walking so we
// match exactly what the user's own shell would pick.
export function resolveClaudeBinaries() {
  // `which -a` prints one path per line, highest-priority first. If nothing
  // is found it exits non-zero, which we treat as "no claude on PATH".
  let out = "";
  try {
    out = execFileSync("/usr/bin/which", ["-a", "claude"], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  // De-dupe while preserving order: nvm shims commonly list the same real
  // path twice (a shim plus its target), which is noise, not a conflict.
  const seen = new Set();
  const paths = [];
  for (const line of out.split("\n")) {
    const p = line.trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

export function claudeVersion(binPath) {
  // Best-effort `--version`. Returns null if the binary won't report one so
  // callers can render "unknown" rather than crashing a health check.
  try {
    const out = execFileSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return out.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function resolveClaude() {
  // Convenience summary for the display commands: the winning binary, its
  // version, and how many total copies are on PATH (so we can warn on skew).
  const paths = resolveClaudeBinaries();
  if (paths.length === 0) {
    return { found: false, winner: null, version: null, all: [] };
  }
  const winner = paths[0];
  return {
    found: true,
    winner,
    version: claudeVersion(winner),
    all: paths,
    shadowed: paths.slice(1),
  };
}
