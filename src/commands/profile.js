// Choosing which profile Claude Code uses. The choice is global: `switch` (or `set-default`)
// saves it, and the `claude` command reads it on every start, in every terminal.
// `resolve-dir` and `shell-init` are the helpers the `claude` wrapper uses.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { select } from "@inquirer/prompts";
import { getRegistry, configDir } from "../registry.js";
import { HOME, ok, info, warn } from "../util.js";
import { detectShell, rcPathForShell } from "../shell.js";
import { fileURLToPath } from "node:url";

const DEFAULT = "default";

// The profiles that can be chosen: the normal ~/.claude account, then every Claude Code
// profile in the registry.
export function listProfiles() {
  const profiles = [{ name: DEFAULT, configDir: path.join(HOME, ".claude") }];
  for (const p of getRegistry().profiles) {
    if (p.code?.configDir) profiles.push({ name: p.name, configDir: p.code.configDir });
  }
  return profiles;
}

function defaultFile() {
  return path.join(configDir(), "default");
}

// The profile saved with set-default (DEFAULT when none is saved).
export function savedDefault() {
  try {
    return fs.readFileSync(defaultFile(), "utf8").trim() || DEFAULT;
  } catch {
    return DEFAULT;
  }
}

// The profile in use: this session's choice (CLAUDE_MP_PROFILE, set by switch --session), else the saved one.
export function currentProfile() {
  return process.env.CLAUDE_MP_PROFILE || savedDefault();
}

function findNamed(name) {
  return listProfiles().find((p) => p.name === name);
}

function requireProfile(name) {
  const found = findNamed(name);
  if (!found) {
    const names = listProfiles().map((p) => p.name).join(", ");
    throw new Error(`No profile named "${name}". Profiles: ${names}.`);
  }
  return found;
}

// Asks which profile to use. The line in use now is marked with *.
async function pickProfile(question) {
  const current = currentProfile();
  return select({
    message: question,
    choices: listProfiles().map((p) => ({
      name: `${p.name === current ? "*" : " "} ${p.name.padEnd(12)} ${p.configDir}`,
      value: p.name,
    })),
    pageSize: 10,
  });
}

// Saves NAME as the profile for every terminal.
function saveDefault(name) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(defaultFile(), `${name}\n`);
}

// The shell line that sets this session's profile, for the shell in use.
function sessionLine(name) {
  const shell = process.env.CMP_SHELL || detectShell();
  return shell === "fish" ? `set -gx CLAUDE_MP_PROFILE ${name}` : `export CLAUDE_MP_PROFILE=${name}`;
}

// Applies NAME to this terminal only. The wrapper (shell-init --install) sources the line; without the
// wrapper the line is printed, so eval "$(claude-multiprofile switch NAME --session)" works.
function applySession(name) {
  const line = sessionLine(name);
  const file = process.env.CMP_EVAL_FILE;
  if (file) {
    fs.writeFileSync(file, `${line}\n`);
    ok(`This session uses ${name}.`);
    return;
  }
  console.log(line);
  info(`This terminal is not set yet. Install the wrapper once (claude-multiprofile shell-init --install),`);
  info(`or run: eval "$(claude-multiprofile switch ${name} --session)"`);
}

// `claude-multiprofile switch [NAME] [--all|--session]`.
// Asks the scope (all terminals, or this session only) unless a flag says which, and asks the profile
// unless NAME is given.
export async function switchCmd(args) {
  let scope = null;
  const rest = [];
  for (const a of args) {
    if (a === "--all") scope = "all";
    else if (a === "--session") scope = "session";
    else rest.push(a);
  }
  if (!scope) {
    scope = await select({
      message: "Switch for:",
      choices: [
        { name: "All terminals (saved; the claude command uses it everywhere)", value: "all" },
        { name: "This session only (this terminal)", value: "session" },
      ],
    });
  }
  const name = rest[0] || (await pickProfile(scope === "session" ? "Use which profile in THIS session?" : "Switch Claude Code to which profile? (every terminal)"));
  requireProfile(name);
  if (scope === "session") {
    applySession(name);
  } else {
    saveDefault(name);
    ok(`Claude Code now uses ${name} in every terminal.`);
  }
}

// Same as switch; kept as a name for the same thing.
export async function setDefaultCmd(args) {
  return switchCmd(args);
}

// `claude-multiprofile current`: the profile in use here.
export function currentCmd() {
  console.log(currentProfile());
}

// `claude-multiprofile resolve-dir [NAME]`: the config folder for NAME, or for the profile in use
// ("" for default). The wrapper and the shim call this on every `claude` start. An unknown NAME is an error.
export function resolveDirCmd(args) {
  if (args[0]) {
    const found = requireProfile(args[0]);
    console.log(found.name === DEFAULT ? "" : found.configDir);
    return;
  }
  const name = currentProfile();
  const found = findNamed(name);
  if (!found) {
    warn(`Profile "${name}" no longer exists; using the default account.`);
    console.log("");
    return;
  }
  console.log(name === DEFAULT ? "" : found.configDir);
}

// Path of the real claude program, for the wrappers to call.
function claudeBinary() {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || "claude";
  } catch {
    return "claude";
  }
}

// The `claude` wrapper text for one shell. It asks `resolve-dir` on every start, so a switch applies
// right away in every terminal.
function wrapperText(shell, bin) {
  if (shell === "fish") {
    return `# claude-multiprofile: the claude command. Uses the profile in use, or --profile NAME for this run.
function claude --wraps claude
    set -l profile
    set -l rest
    set -l i 1
    while test $i -le (count $argv)
        set -l a $argv[$i]
        if test "$a" = --profile
            set i (math $i + 1)
            set profile $argv[$i]
        else if string match -q -- '--profile=*' "$a"
            set profile (string replace -- '--profile=' '' "$a")
        else
            set -a rest "$a"
        end
        set i (math $i + 1)
    end
    set -l dir (command claude-multiprofile resolve-dir $profile)
    or return 1
    if test -n "$dir"
        env CLAUDE_CONFIG_DIR="$dir" "${bin}" $rest
    else
        env -u CLAUDE_CONFIG_DIR "${bin}" $rest
    end
end
`;
  }
  // bash and zsh share the same syntax.
  return `# claude-multiprofile: the claude command. Uses the profile in use, or --profile NAME for this run.
claude() {
  local profile="" args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      --profile=*) profile="\${1#--profile=}"; shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  local d
  if [ -n "$profile" ]; then d="$(command claude-multiprofile resolve-dir "$profile")" || return 1
  else d="$(command claude-multiprofile resolve-dir)" || return 1; fi
  if [ -n "$d" ]; then CLAUDE_CONFIG_DIR="$d" "${bin}" "\${args[@]}"; else env -u CLAUDE_CONFIG_DIR "${bin}" "\${args[@]}"; fi
}
`;
}

const RC_START = "# >>> claude-multiprofile wrapper >>>";
const RC_END = "# <<< claude-multiprofile wrapper <<<";

// Removes the marked wrapper block from a shell config file, if there is one.
function removeBlock(rc) {
  let current;
  try {
    current = fs.readFileSync(rc, "utf8");
  } catch {
    return;
  }
  const start = current.indexOf(RC_START);
  const end = current.indexOf(RC_END);
  if (start === -1 || end <= start) return;
  const next = current.slice(0, start) + current.slice(end + RC_END.length).replace(/^\n/, "");
  fs.writeFileSync(rc, next);
}

// `claude-multiprofile shell-init [fish|bash|zsh] [--install]`.
// Without --install it prints the wrapper. With --install, fish gets the wrapper as
// ~/.config/fish/functions/claude.fish (fish loads it on first use, like nvm.fish). bash and zsh get a
// marked block in their rc file. An older block (from an earlier version) is removed.
export function shellInitCmd(args) {
  const install = args.includes("--install");
  const shell = args.find((a) => a !== "--install") || detectShell();
  if (!["fish", "bash", "zsh"].includes(shell)) throw new Error(`Unknown shell "${shell}". Use fish, bash or zsh.`);
  const text = wrapperText(shell, claudeBinary());
  if (!install) {
    console.log(text);
    return;
  }
  if (shell === "fish") {
    const file = path.join(HOME, ".config", "fish", "functions", "claude.fish");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    removeBlock(rcPathForShell(shell));
    ok(`Installed the claude wrapper at ${file} (fish loads it on first use).`);
    return;
  }
  const rc = rcPathForShell(shell);
  const block = `${RC_START}\n${text}${RC_END}\n`;
  let current = "";
  try {
    current = fs.readFileSync(rc, "utf8");
  } catch {
    current = "";
  }
  const start = current.indexOf(RC_START);
  const end = current.indexOf(RC_END);
  const next = start !== -1 && end > start
    ? current.slice(0, start) + block + current.slice(end + RC_END.length).replace(/^\n/, "")
    : current + (current && !current.endsWith("\n") ? "\n" : "") + block;
  fs.writeFileSync(rc, next);
  ok(`Installed the claude wrapper in ${rc}`);
}

// ---- The claude shim -------------------------------------------------------
//
// `shell-init` only helps interactive shells that load your config. The shim is a small program
// placed where `claude` is found, so scripts, cron jobs and IDE terminals use the profile too.
// It runs the real Claude program with CLAUDE_CONFIG_DIR set to the profile in use.

const SHIM_MARK = "# claude-multiprofile shim (managed)";

function claudeLinkPath() {
  return path.join(HOME, ".local", "bin", "claude");
}

function isShim(file) {
  try {
    return fs.readFileSync(file, "utf8").includes(SHIM_MARK);
  } catch {
    return false;
  }
}

// `claude-multiprofile install-shim`: replaces ~/.local/bin/claude with the shim.
export function installShimCmd() {
  const link = claudeLinkPath();
  if (isShim(link)) {
    ok("The claude shim is already installed.");
    return;
  }
  let real;
  try {
    real = fs.realpathSync(link);
  } catch {
    throw new Error(`No claude program found at ${link}. Install Claude Code first.`);
  }
  const cmp = fileURLToPath(new URL("../../bin/claude-multiprofile.js", import.meta.url));
  const script = `#!/bin/sh
${SHIM_MARK}
# Runs the real claude with the config folder of the profile in use.
# Remove it with: claude-multiprofile remove-shim
REAL=${JSON.stringify(real)}
dir="$("${process.execPath}" ${JSON.stringify(cmp)} resolve-dir 2>/dev/null)"
if [ -n "$dir" ]; then CLAUDE_CONFIG_DIR="$dir"; export CLAUDE_CONFIG_DIR; else unset CLAUDE_CONFIG_DIR; fi
exec "$REAL" "$@"
`;
  fs.unlinkSync(link);
  fs.writeFileSync(link, script, { mode: 0o755 });
  ok(`Installed the claude shim at ${link} (runs ${real}).`);
}

// `claude-multiprofile remove-shim`: puts the original link back.
export function removeShimCmd() {
  const link = claudeLinkPath();
  if (!isShim(link)) {
    ok("No claude shim is installed.");
    return;
  }
  const real = fs.readFileSync(link, "utf8").match(/^REAL="(.+)"$/m)?.[1];
  if (!real) throw new Error(`Could not read the original claude path from ${link}.`);
  fs.unlinkSync(link);
  fs.symlinkSync(real, link);
  ok(`Removed the claude shim. ${link} points to ${real} again.`);
}
