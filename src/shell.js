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
import { HOME } from "./util.js";

const BLOCK_START = "# >>> claude-multiprofile >>>";
const BLOCK_END = "# <<< claude-multiprofile <<<";

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

export function writeAliases(shell, aliasLines) {
  // Replace (or insert) our managed block with the given alias lines.
  // `aliasLines` is an array of full `alias foo='bar'` strings.
  const rcPath = rcPathForShell(shell);
  const content = readRcFile(rcPath);
  const { before, after, hasBlock } = extractBlock(content);

  const block = [
    BLOCK_START,
    "# Managed by claude-multiprofile. Edits inside this block may be overwritten.",
    "# Run `claude-multiprofile list` to see what's configured.",
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

export function buildAliasLine(shell, aliasName, configDir) {
  // We use single quotes so $HOME stays literal and gets expanded by the
  // shell at alias-call time, not at definition time. That keeps the alias
  // portable across machines if the user syncs their dotfiles.
  if (shell === "fish") {
    // Fish has a different syntax. We define a function rather than an alias
    // because Fish's `alias` doesn't preserve env-var prefixing the way Bash
    // and Zsh do.
    return `function ${aliasName}; CLAUDE_CONFIG_DIR="${configDir}" claude $argv; end`;
  }
  return `alias ${aliasName}='CLAUDE_CONFIG_DIR="${configDir}" claude'`;
}
