// Shared utilities: logging, paths, OS detection.
//
// Keeping these in one place so the rest of the codebase can stay
// focused on its own concerns. Nothing here is fancy; it's mostly
// pretty-printing and a handful of constants.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ---- ANSI styling ----------------------------------------------------------
//
// We do not pull in chalk or picocolors. The set of styles we need is small,
// and shelling out the bytes by hand keeps the dependency tree minimal.
// macOS Terminal, iTerm2, Warp, and VS Code's terminal all support these.

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function style(s, ...codes) {
  // Skip styling when stdout is not a TTY (piped output, CI, etc.) so the
  // text stays clean for downstream consumers. Same convention chalk uses.
  if (!process.stdout.isTTY) return s;
  return codes.map((c) => ansi[c]).join("") + s + ansi.reset;
}

// ---- Logging primitives ----------------------------------------------------
//
// These have semantic names (`ok`, `warn`, `info`, etc.) rather than just
// colour names. That way the call sites read like prose: `ok("Done.")`.

export function ok(msg) {
  console.log(style("✓ ", "green", "bold") + msg);
}

export function warn(msg) {
  console.log(style("⚠ ", "yellow", "bold") + msg);
}

export function err(msg) {
  console.error(style("✗ ", "red", "bold") + msg);
}

export function info(msg) {
  console.log(style("ℹ ", "blue") + msg);
}

export function step(msg) {
  // Used between major phases of the wizard so the user can tell where we are.
  console.log("\n" + style("→ " + msg, "cyan", "bold"));
}

export function header(msg) {
  // Used once at the top of a command.
  const bar = "─".repeat(Math.min(msg.length + 4, 60));
  console.log("\n" + style(bar, "gray"));
  console.log("  " + style(msg, "bold"));
  console.log(style(bar, "gray") + "\n");
}

export function explain(text) {
  // Multi-line explanatory prose, dimmed slightly so it reads as commentary
  // rather than instruction. We dedent and collapse blank lines at edges.
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");
  for (const line of lines) console.log(style(line, "dim"));
  console.log("");
}

export function command(cmd) {
  // For when we want to display a shell command the user could run.
  return style(cmd, "cyan");
}

export function pathStr(p) {
  // Style a filesystem path consistently throughout output.
  return style(p, "yellow");
}

// ---- Path helpers ----------------------------------------------------------

export const HOME = os.homedir();

export function expandHome(p) {
  // Lets us accept "~/foo" everywhere and resolve it once.
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

export function tildify(p) {
  // The reverse: shorten "/Users/x/foo" to "~/foo" for display.
  if (!p) return p;
  if (p.startsWith(HOME + path.sep)) return "~" + p.slice(HOME.length);
  if (p === HOME) return "~";
  return p;
}

// ---- OS / environment ------------------------------------------------------

export function isMac() {
  return process.platform === "darwin";
}

export function requireMac(feature) {
  // Used by the Desktop module since Claude Desktop multi-profile via
  // --user-data-dir is a macOS-specific recipe. Linux and Windows users get
  // a clear error rather than a silent failure deeper in the script.
  if (!isMac()) {
    err(`${feature} requires macOS. Detected platform: ${process.platform}`);
    process.exit(1);
  }
}

export function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---- Misc ------------------------------------------------------------------

export function sanitizeName(name) {
  // Strip everything that isn't safe in filesystem paths or shell aliases.
  // We're conservative here because the name flows into:
  //   - directory names (~/.claude-{name})
  //   - .app names (Claude {Name}.app)
  //   - shell alias names (claude-{name})
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function titleCase(name) {
  // Used when building the display name of the .app, so "work" -> "WORK"
  // for short tokens and "client-acme" -> "Client Acme" for hyphenated ones.
  if (name.length <= 4) return name.toUpperCase();
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
