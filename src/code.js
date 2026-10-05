// Claude Code profile setup.
//
// Background:
//
// Claude Code is the terminal CLI distinct from the Desktop app. It stores
// all of its state under `~/.claude` by default: credentials, project
// memory, plugins, skills, MCP server config, slash command definitions,
// and so on.
//
// The CLI honors a (currently undocumented but stable) environment
// variable, `CLAUDE_CONFIG_DIR`, that overrides this default. Set it to a
// different folder before launching `claude`, and you get a totally
// independent profile: separate auth, separate history, separate plugins.
//
// What this module does:
//
//   1. Creates the new config directory.
//   2. Optionally seeds it from your existing ~/.claude (handy for carrying
//      over installed skills, plugins, and MCP server config without
//      re-doing them all). Authentication does *not* carry over because
//      Claude Code stores its OAuth token in macOS Keychain, keyed by a
//      hash of CLAUDE_CONFIG_DIR. Different dir = different keychain
//      entry = no shared login. Convenient and safe.
//   3. Adds a managed shell alias so you can launch the profile by name:
//
//        claude-work   ->  CLAUDE_CONFIG_DIR=~/.claude-work claude
//
// On first run of the new alias, the user runs /login inside the Claude
// Code REPL and signs in with the account they want associated with that
// profile. From then on, the alias keeps that account's session.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, pathStr, tildify, ok, info, warn, step } from "./util.js";
import { resolveBinaries } from "./claudebin.js";
import {
  detectShell,
  rcPathForShell,
  readManagedAliases,
  writeAliases,
  buildAliasLine,
} from "./shell.js";

// Default location for the brand-new profile's config dir.
export function defaultConfigDirFor(name) {
  return path.join(HOME, `.claude-${name}`);
}

// The default Claude Code config dir. Used when we offer to seed the new
// profile from an existing setup.
export const DEFAULT_CLAUDE_CONFIG_DIR = path.join(HOME, ".claude");

// Where a profile's GitHub CLI config lives when gh isolation is enabled.
//
// It sits INSIDE the profile's config dir on purpose: `rename` moves it and
// `remove` deletes it without either command needing to know gh exists. The
// GitHub CLI honours GH_CONFIG_DIR the same way Claude Code honours
// CLAUDE_CONFIG_DIR, so pointing it here gives the profile its own hosts.yml
// and therefore its own logged-in GitHub account.
export function defaultGhConfigDirFor(configDir) {
  return path.join(configDir, "gh");
}

// Is the GitHub CLI available? Only then is offering to isolate it useful.
export function hasGhCli() {
  return resolveBinaries("gh").length > 0;
}

// GH_TOKEN and friends take precedence over anything in a gh config dir, so a
// globally-exported token silently defeats per-profile isolation. Returns the
// offending variable name, or null.
export function ghTokenOverride(env = process.env) {
  for (const v of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) {
    if (env[v]) return v;
  }
  return null;
}

export function defaultAliasNameFor(name) {
  // Human-friendly alias users will actually type.
  // We deliberately don't reuse the bare `claude` command since that's
  // the default Claude Code binary. Shadowing it with an alias would
  // surprise users and break tooling that assumes `claude` is the original.
  return `claude-${name}`;
}

// ---- Directory setup -----------------------------------------------------

export function ensureConfigDir(configDir, { seedFromDefault } = {}) {
  // If the directory already exists, we leave it alone. The user is
  // probably re-running the wizard after partial completion, and we do
  // not want to clobber state they may have intentionally put there.
  if (fs.existsSync(configDir)) return false;

  if (seedFromDefault && fs.existsSync(DEFAULT_CLAUDE_CONFIG_DIR)) {
    return seedConfigDir(DEFAULT_CLAUDE_CONFIG_DIR, configDir);
  }
  fs.mkdirSync(configDir, { recursive: true });
  return true;
}

// ---- Seeding a new profile from an existing setup -----------------------
//
// Until v0.1.31 this copied the whole of ~/.claude and then deleted three
// credential filenames. That is a denylist, and it failed in the direction
// that matters: it copied the default account's conversation transcripts
// (projects/) and prompt history (history.jsonl) into every seeded profile,
// which is exactly the cross-account bleed a profile exists to prevent. It
// would also have copied any credential file Anthropic adds in future under
// a name we do not know yet.
//
// So it is an allowlist now: what a new profile takes is named here, and
// anything not named stays behind, including anything that does not exist
// yet. The rule for inclusion is "setup you would otherwise redo by hand",
// never "state from using an account".

// Top-level entries of ~/.claude that are setup.
export const SEED_ITEMS = [
  "settings.json",
  "CLAUDE.md",
  "keybindings.json",
  "skills",
  "commands",
  "agents",
  "hooks",
  "output-styles",
];

// Inside plugins/: what is installed, not what plugins have stored. `data/`
// is each plugin's own saved state, `synced/` is tied to the signed-in
// account, and the catalog cache is rebuilt on demand.
export const SEED_PLUGIN_ITEMS = [
  "installed_plugins.json",
  "known_marketplaces.json",
  "config.json",
  "blocklist.json",
  "cache",
  "marketplaces",
  "repos",
];

// User-scope MCP servers live in ~/.claude.json, OUTSIDE ~/.claude, next to
// the account's identity, usage and caches. With CLAUDE_CONFIG_DIR set, Claude
// Code reads <config dir>/.claude.json instead. Only the mcpServers entry is
// taken from it.
export const DEFAULT_USER_CONFIG_FILE = path.join(HOME, ".claude.json");

function copyEntry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // -c asks for an APFS clone, which makes even a large plugins folder cost
  // almost nothing; other filesystems fall back to a real copy.
  try {
    execFileSync("/bin/cp", ["-Rc", from, to], { stdio: "pipe" });
  } catch {
    execFileSync("/bin/cp", ["-R", from, to], { stdio: "pipe" });
  }
}

// Point paths that lead into the source profile at the new one instead.
//
// Plugin manifests and settings store absolute paths (a hook script, a
// marketplace clone). Copied verbatim, the new profile would keep loading
// those from the old profile's folder, and updating a plugin there would
// quietly change it here too. A path is only rewritten when what it points to
// exists in the new profile; otherwise it keeps working from where it was.
export function rebasePaths(text, fromDir, toDir, { home = HOME, exists = () => true } = {}) {
  const fromRel = path.relative(home, fromDir);
  const toRel = path.relative(home, toDir);
  const fromInHome = fromRel && !fromRel.startsWith("..") && !path.isAbsolute(fromRel);
  const toInHome = toRel && !toRel.startsWith("..") && !path.isAbsolute(toRel);

  const forms = [[`${fromDir}/`, `${toDir}/`]];
  if (fromInHome) {
    forms.push([`~/${fromRel}/`, toInHome ? `~/${toRel}/` : `${toDir}/`]);
    forms.push([`$HOME/${fromRel}/`, toInHome ? `$HOME/${toRel}/` : `${toDir}/`]);
    forms.push([`\${HOME}/${fromRel}/`, toInHome ? `\${HOME}/${toRel}/` : `${toDir}/`]);
  }
  let out = String(text);
  for (const [from, to] of forms) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The path ends at whitespace or a quote, so a command line such as
    // "bash ~/.claude/hooks/x.sh --flag" keeps its arguments.
    out = out.replace(new RegExp(`${esc}([^\\s"'\`]*)`, "g"), (m, rel) =>
      exists(rel) ? `${to}${rel}` : m
    );
  }
  return out;
}

function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

// Which keys of settings.json hold paths that mean "this profile's own copy".
//
// Only these are ever rewritten. v0.1.31 rewrote every string in the file,
// and settings also hold paths that point at the DEFAULT profile on purpose.
// `claudeMdExcludes` is the case that bit (#10): a work profile excluding
// ~/.claude/CLAUDE.md, so Code does not load the default profile's
// instructions as a parent-folder CLAUDE.md, had that entry turned into its
// own CLAUDE.md, reversing the intent. Hooks and the status line are commands
// to run, and running the profile's own copy is what seeding them is for.
export const SETTINGS_REBASE_KEYS = ["hooks", "statusLine"];

function rebaseValue(value, fromDir, toDir, exists, keys) {
  if (!keys) return mapStrings(value, (s) => rebasePaths(s, fromDir, toDir, { exists }));
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      keys.includes(k) ? mapStrings(v, (s) => rebasePaths(s, fromDir, toDir, { exists })) : v,
    ])
  );
}

// Rewrite a JSON file's string values with rebasePaths. With `keys`, only the
// values under those top-level keys are considered. A file that does not
// parse is left exactly as it is. Returns true if anything changed.
export function rebaseJsonFile(file, fromDir, toDir, { keys = null } = {}) {
  let before;
  try {
    before = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const exists = (rel) => fs.existsSync(path.join(toDir, rel));
  const after = rebaseValue(before, fromDir, toDir, exists, keys);
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n", "utf8");
  return true;
}

// For doctor: how many paths in a JSON file still lead into `fromDir`, split
// into those the profile has its own copy of (safe to rebase) and those it
// does not (still load from the other profile, and must stay that way). With
// `keys`, only the values under those top-level keys count.
export function pathsIntoOtherProfile(file, fromDir, toDir, { keys = null } = {}) {
  const result = { rebasable: 0, stuck: 0 };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return result;
  }
  const scope = keys
    ? Object.fromEntries(Object.entries(parsed || {}).filter(([k]) => keys.includes(k)))
    : parsed;
  rebasePaths(JSON.stringify(scope), fromDir, toDir, {
    exists: (rel) => {
      if (fs.existsSync(path.join(toDir, rel))) result.rebasable++;
      else result.stuck++;
      return false;
    },
  });
  return result;
}

// #10: entries v0.1.31 turned from the default profile's file into the
// profile's own. An exclusion of a profile's OWN CLAUDE.md is what that
// rewrite produced, and the original target still exists in the default
// profile, so pointing it back is safe. Returns [{ from, to }] for each entry
// that would change; with `apply`, writes the file.
export function flippedClaudeMdExcludes(settingsFile, profileDir, defaultDir, { apply = false } = {}) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch {
    return [];
  }
  const list = settings && Array.isArray(settings.claudeMdExcludes) ? settings.claudeMdExcludes : null;
  if (!list) return [];
  const exists = (rel) => fs.existsSync(path.join(defaultDir, rel));
  const changes = [];
  const restored = list.map((entry) => {
    if (typeof entry !== "string") return entry;
    const back = rebasePaths(entry, profileDir, defaultDir, { exists });
    if (back !== entry) changes.push({ from: entry, to: back });
    return back;
  });
  if (apply && changes.length > 0) {
    settings.claudeMdExcludes = restored;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return changes;
}

// Conversations a pre-v0.1.31 seed copied in: transcripts present in both
// profiles under the same project and session ID. Session IDs are unique per
// conversation, so a match can only have come from a copy.
export function copiedTranscripts(profileDir, sourceDir) {
  const list = (root) => {
    const out = new Set();
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.name.endsWith(".jsonl")) out.add(r);
      }
    };
    walk(path.join(root, "projects"), "");
    return out;
  };
  const theirs = list(sourceDir);
  let n = 0;
  for (const r of list(profileDir)) if (theirs.has(r)) n++;
  return n;
}

// Returns a summary: { items: [...copied names], plugins: bool, mcpServers: n }.
export function seedConfigDir(fromDir, toDir, { userConfigFile = DEFAULT_USER_CONFIG_FILE } = {}) {
  fs.mkdirSync(toDir, { recursive: true });
  const summary = { items: [], plugins: false, mcpServers: 0 };

  for (const item of SEED_ITEMS) {
    const src = path.join(fromDir, item);
    if (!fs.existsSync(src)) continue;
    copyEntry(src, path.join(toDir, item));
    summary.items.push(item);
  }

  const pluginsFrom = path.join(fromDir, "plugins");
  if (fs.existsSync(pluginsFrom)) {
    for (const item of SEED_PLUGIN_ITEMS) {
      const src = path.join(pluginsFrom, item);
      if (fs.existsSync(src)) copyEntry(src, path.join(toDir, "plugins", item));
    }
    for (const manifest of ["installed_plugins.json", "known_marketplaces.json"]) {
      const f = path.join(toDir, "plugins", manifest);
      if (fs.existsSync(f)) rebaseJsonFile(f, fromDir, toDir);
    }
    summary.plugins = true;
  }

  const settings = path.join(toDir, "settings.json");
  if (fs.existsSync(settings)) rebaseJsonFile(settings, fromDir, toDir, { keys: SETTINGS_REBASE_KEYS });

  // MCP servers: the one entry of ~/.claude.json that is setup.
  try {
    const servers = JSON.parse(fs.readFileSync(userConfigFile, "utf8")).mcpServers;
    if (servers && typeof servers === "object" && Object.keys(servers).length > 0) {
      const file = path.join(toDir, ".claude.json");
      fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8");
      rebaseJsonFile(file, fromDir, toDir);
      summary.mcpServers = Object.keys(servers).length;
    }
  } catch {
    // No ~/.claude.json, or unreadable: nothing to carry over.
  }
  return summary;
}

// ---- Shell alias setup ---------------------------------------------------

export function addAlias({ aliasName, configDir, ghConfigDir }) {
  // We rebuild the entire managed block on every write rather than
  // appending. This keeps the aliases in a stable order (alphabetical)
  // and prevents duplicates.
  const shell = detectShell();
  const existing = readManagedAliases(shell).filter((a) => a.name !== aliasName);
  const newLine = buildAliasLine(shell, aliasName, configDir, ghConfigDir);
  const allLines = [...existing.map((a) => a.line), newLine].sort();
  const rcPath = writeAliases(shell, allLines);
  return { shell, rcPath };
}

export function removeAlias(aliasName) {
  const shell = detectShell();
  const remaining = readManagedAliases(shell).filter((a) => a.name !== aliasName);
  const lines = remaining.map((a) => a.line).sort();
  const rcPath = writeAliases(shell, lines);
  return { shell, rcPath };
}

// ---- Top-level orchestration ---------------------------------------------

export function setupCode({ name, configDir, aliasName, seedFromDefault, isolateGh }) {
  step(`Creating Claude Code profile "${name}"`);

  const ghConfigDir = isolateGh ? defaultGhConfigDirFor(configDir) : null;

  info(`Config folder: ${pathStr(tildify(configDir))}`);
  info(`Shell alias: ${pathStr(aliasName)}`);
  if (ghConfigDir) info(`GitHub CLI config: ${pathStr(tildify(ghConfigDir))}`);

  const created = ensureConfigDir(configDir, { seedFromDefault });
  if (created) {
    if (seedFromDefault && typeof created === "object") {
      const parts = [...created.items];
      if (created.plugins) parts.push("plugins");
      if (created.mcpServers) parts.push(`${created.mcpServers} MCP server${created.mcpServers === 1 ? "" : "s"}`);
      ok(`Config folder created and seeded from ${pathStr(tildify(DEFAULT_CLAUDE_CONFIG_DIR))}.`);
      ok(parts.length ? `Carried over: ${parts.join(", ")}.` : "There was no setup to carry over.");
      info("Not carried over: conversations, prompt history, sessions, caches, or sign-in.");
    } else {
      ok("Config folder created (empty).");
    }
  } else {
    warn(`Config folder already existed; left untouched. (${pathStr(tildify(configDir))})`);
  }

  if (ghConfigDir) {
    // gh creates its own files on first login; we just make the directory so
    // the alias points somewhere real and `gh auth login` has a home.
    fs.mkdirSync(ghConfigDir, { recursive: true });
    ok("GitHub CLI config folder ready (sign in separately with `gh auth login`).");
  }

  const { shell, rcPath } = addAlias({ aliasName, configDir, ghConfigDir });
  ok(`Alias "${aliasName}" added to ${pathStr(tildify(rcPath))} (shell: ${shell}).`);

  return { configDir, aliasName, shell, rcPath, ghConfigDir };
}
