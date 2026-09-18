// Shell config helpers.
//
// The Claude Code side of this tool works by adding a shell alias like:
//
//     alias claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'
//
// We need to add that alias to the right rc file (.zshrc, .bashrc, etc.)
// and we need to do it idempotently so re-running `claude-multiprofile add`
// doesn't pile up duplicate lines.
//
// Strategy: we wrap our managed lines in a delimited block:
//
//     # >>> claude-multiprofile >>>
//     ...managed lines...
//     # <<< claude-multiprofile <<<
//
// On every write we replace the contents of that block. If the user has
// hand-edited inside the markers, we will overwrite them, but that's the
// price of an idempotent strategy. Anything outside the markers is never
// touched.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME } from "./util.js";

const BLOCK_START = "# >>> claude-multiprofile >>>";
const BLOCK_END = "# <<< claude-multiprofile <<<";

// A shell reads its rc file once, at startup. Every alias we write reaches
// running terminals only when they are restarted or the file is re-sourced,
// so a terminal opened before the last change keeps answering to aliases
// that no longer exist on disk. Renaming a profile is the case that bites:
// the old alias still runs and still points at the old config directory,
// which has since been moved.
//
// Detecting that needs to know when OUR aliases last changed, which is not
// the same as when the rc file was last touched. Dotfiles get edited by
// installers and by their owners all the time, and warning about someone
// else's edit to .zshrc would be noise. So the block carries its own
// timestamp.
const STAMP_PREFIX = "# updated ";

// ---- Detection -----------------------------------------------------------

export function detectShell() {
  // Trust $SHELL when present. It's how the user actually runs commands.
  const shell = process.env.SHELL || "";
  if (shell.endsWith("/zsh")) return "zsh";
  if (shell.endsWith("/bash")) return "bash";
  if (shell.endsWith("/fish")) return "fish";
  // Modern macOS defaults to zsh, so that's the safest fallback.
  return "zsh";
}

export function rcPathForShell(shell) {
  switch (shell) {
    case "zsh":
      // .zshrc is the right file for interactive shells, which is where
      // aliases need to live to be available in your normal terminal.
      return path.join(HOME, ".zshrc");
    case "bash":
      // On macOS, .bash_profile is sourced for login shells; .bashrc isn't
      // sourced by default. We pick .bash_profile to match how Terminal.app
      // actually launches bash on Mac. Linux users typically have .bashrc
      // sourced by their login dotfile, so it works there too.
      return path.join(HOME, ".bash_profile");
    case "fish":
      return path.join(HOME, ".config", "fish", "config.fish");
    default:
      return path.join(HOME, ".profile");
  }
}

// ---- Read / write ---------------------------------------------------------

function readRcFile(rcPath) {
  // Returns "" if file doesn't exist; that's fine, we'll create it.
  try {
    return fs.readFileSync(rcPath, "utf8");
  } catch {
    return "";
  }
}

function extractBlock(content) {
  // Returns { before, inside, after } so callers can splice in new content.
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx === -1) {
    return { before: content, inside: "", after: "", hasBlock: false };
  }
  const afterStart = startIdx + BLOCK_START.length;
  const endIdx = content.indexOf(BLOCK_END, afterStart);
  if (endIdx === -1) {
    // Start marker but no end marker. Treat as no block to avoid eating
    // lines the user might want to keep.
    return { before: content, inside: "", after: "", hasBlock: false };
  }
  return {
    before: content.slice(0, startIdx),
    inside: content.slice(afterStart, endIdx),
    after: content.slice(endIdx + BLOCK_END.length),
    hasBlock: true,
  };
}

// ---- Public API ----------------------------------------------------------

export function readManagedAliases(shell) {
  // Returns an array of { name, line } entries currently inside our block.
  const rcPath = rcPathForShell(shell);
  const content = readRcFile(rcPath);
  const { inside, hasBlock } = extractBlock(content);
  if (!hasBlock) return [];
  return inside
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("alias "))
    .map((line) => {
      const m = line.match(/^alias\s+([^\s=]+)=/);
      return { name: m ? m[1] : null, line };
    })
    .filter((e) => e.name);
}

export function readAliasStamp(shell) {
  // When our managed block last changed, in epoch ms, or null if the block
  // predates stamping or is absent.
  const { inside, hasBlock } = extractBlock(readRcFile(rcPathForShell(shell)));
  if (!hasBlock) return null;
  for (const line of inside.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(STAMP_PREFIX)) continue;
    const at = new Date(trimmed.slice(STAMP_PREFIX.length).trim()).getTime();
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

export function writeAliases(shell, aliasLines) {
  // Replace (or insert) our managed block with the given alias lines.
  // `aliasLines` is an array of full `alias foo='bar'` strings.
  const rcPath = rcPathForShell(shell);
  const content = readRcFile(rcPath);
  const { before, after, hasBlock } = extractBlock(content);

  // No aliases left (last Code profile removed): take the whole managed
  // block out rather than leaving an empty marker pair in the rc file.
  if (aliasLines.length === 0) {
    if (hasBlock) {
      const next =
        before.replace(/\s*$/, "") + after.replace(/^\s*/, "\n");
      fs.writeFileSync(rcPath, next.replace(/^\n+/, "") , "utf8");
    }
    return rcPath;
  }

  // Only re-stamp when the aliases actually differ. Rewriting the timestamp
  // on a no-op write would claim a change that did not happen, and would
  // churn the rc file for anyone who keeps their dotfiles in git.
  const previous = readManagedAliases(shell).map((a) => a.line);
  const unchanged =
    hasBlock &&
    previous.length === aliasLines.length &&
    previous.every((line, i) => line === aliasLines[i]);
  // An unchanged block with no stamp stays unstamped rather than gaining an
  // invented one. It picks up a real timestamp the next time it changes.
  const stamp = unchanged ? readAliasStamp(shell) : Date.now();

  const block = [
    BLOCK_START,
    "# Managed by claude-multiprofile. Edits inside this block may be overwritten.",
    "# Run `claude-multiprofile list` to see what's configured.",
    ...(stamp ? [STAMP_PREFIX + new Date(stamp).toISOString()] : []),
    "",
    ...aliasLines,
    "",
    BLOCK_END,
  ].join("\n");

  let next;
  if (hasBlock) {
    next = before.replace(/\s*$/, "") + "\n\n" + block + "\n" + after.replace(/^\s*/, "\n");
  } else {
    // Append at the end if it didn't exist yet. We make sure there's a
    // blank line of separation from whatever was there before.
    const trimmed = content.replace(/\s*$/, "");
    next = (trimmed ? trimmed + "\n\n" : "") + block + "\n";
  }

  fs.writeFileSync(rcPath, next, "utf8");
  return rcPath;
}

export function buildAliasLine(shell, aliasName, configDir, ghConfigDir) {
  // We use single quotes so $HOME stays literal and gets expanded by the
  // shell at alias-call time, not at definition time. That keeps the alias
  // portable across machines if the user syncs their dotfiles.
  //
  // GH_CONFIG_DIR is optional. When set, the GitHub CLI reads its hosts.yml
  // (and therefore which account it is logged in as) from the profile's own
  // directory. Claude Code passes its environment to the shell commands it
  // runs, so every `gh` call made inside this profile uses that account.
  const env = [`CLAUDE_CONFIG_DIR="${configDir}"`];
  if (ghConfigDir) env.push(`GH_CONFIG_DIR="${ghConfigDir}"`);
  const prefix = env.join(" ");

  if (shell === "fish") {
    // Fish has a different syntax. We define a function rather than an alias
    // because Fish's `alias` doesn't preserve env-var prefixing the way Bash
    // and Zsh do.
    return `function ${aliasName}; ${prefix} claude $argv; end`;
  }
  return `alias ${aliasName}='${prefix} claude'`;
}

// ---- Is this terminal running the aliases that are on disk? ---------------
//
// Aliases live in the shell process, not on disk, and a child process cannot
// read its parent shell's alias table. What it can do is compare two times:
// when the shell started, and when the aliases last changed. A shell older
// than the change is running whatever the file said back then.
//
// Every step below degrades to "unknown" rather than guessing, because a
// wrong staleness warning is worse than none: it would send people to
// re-source a file that was already fine.

const SESSION_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh"]);

export function isSessionShell(command) {
  // A login shell appears in ps as "-zsh", an interactive one as "/bin/zsh".
  if (!command) return false;
  const parts = String(command).trim().split(/\s+/);
  const base = path.basename(parts[0].replace(/^-/, ""));
  if (!SESSION_SHELLS.has(base)) return false;
  // `zsh -c '...'` runs one command and exits, so it holds no alias state a
  // user could act on. It is also how scripts and other tools invoke us,
  // which would otherwise produce a warning about a shell that lived for
  // milliseconds.
  return !parts.slice(1).includes("-c");
}

export function parsePsRecord(line) {
  // `ps -o ppid=,lstart=,command=` gives "PPID Www Mmm D HH:MM:SS YYYY cmd".
  // lstart contains spaces, so the date is matched by shape rather than by
  // splitting on whitespace.
  const m = String(line).match(
    /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/
  );
  if (!m) return null;
  const startedAt = new Date(m[2]).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return { ppid: Number(m[1]), startedAt, command: m[3] };
}

function psRecord(pid) {
  try {
    return parsePsRecord(
      execFileSync("ps", ["-o", "ppid=,lstart=,command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    );
  } catch {
    return null;
  }
}

export function findSessionShell(startPid = process.ppid) {
  // Usually the direct parent, but npm wrappers and `sudo` add a level or
  // two, so walk up a bounded distance before giving up.
  let pid = startPid;
  for (let hops = 0; hops < 12 && pid > 1; hops++) {
    const rec = psRecord(pid);
    if (!rec) return null;
    if (isSessionShell(rec.command)) {
      return { pid, startedAt: rec.startedAt, command: rec.command };
    }
    pid = rec.ppid;
  }
  return null;
}

export function aliasSessionState(shellStartedAt, aliasesWrittenAt) {
  if (!shellStartedAt || !aliasesWrittenAt) return "unknown";
  return aliasesWrittenAt > shellStartedAt ? "stale" : "current";
}
