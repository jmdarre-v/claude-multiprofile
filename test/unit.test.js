// Tests for the non-interactive parts of the CLI.
//
// We don't try to exercise the prompts themselves; @inquirer/prompts is
// already well tested upstream and our wizard logic is mostly orchestration.
// Here we focus on the pure functions: name sanitization, shell alias
// generation, registry round-tripping, and rc-file editing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// util.js - sanitization and path helpers
// ---------------------------------------------------------------------------

import { sanitizeName, titleCase, expandHome, tildify, compareVersions } from "../src/util.js";

test("printLaunchHints: prints the lowercase command, not the uppercased path", async (t) => {
  const { printLaunchHints } = await import("../src/util.js");
  // titleCase uppercases short names, so a profile called `ipsy` displays as
  // Claude-IPSY / "Claude IPSY.app" while the command is `claude-ipsy`. This
  // hint exists so the case-sensitive thing you type is stated outright.
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  t.after(() => { console.log = orig; });

  printLaunchHints({
    name: "ipsy",
    code: { aliasName: "claude-ipsy" },
    desktop: { appPath: "/Users/x/Applications/Claude IPSY.app" },
  });
  console.log = orig;

  const out = lines.join("\n");
  assert.match(out, /claude-ipsy/, "the alias is shown verbatim");
  assert.match(out, /Claude IPSY\.app/, "the Desktop path is shown as it is on disk");
  assert.match(out, /To launch/);

  // A profile with neither half prints nothing rather than an empty header.
  const before = lines.length;
  console.log = (s) => lines.push(String(s));
  printLaunchHints({ name: "x", code: null, desktop: null });
  console.log = orig;
  assert.equal(lines.length, before, "nothing to launch means no output");
});

test("compareVersions: orders dotted versions numerically", () => {
  assert.ok(compareVersions("0.1.9", "0.1.10") < 0, "9 < 10 numerically, not lexically");
  assert.ok(compareVersions("0.1.11", "0.1.10") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.0", "1.0.1") < 0, "missing parts read as zero");
});

test("sanitizeName: trims, lowercases, replaces unsafe chars with hyphens", () => {
  assert.equal(sanitizeName("  WORK  "), "work");
  assert.equal(sanitizeName("Client ACME"), "client-acme");
  assert.equal(sanitizeName("foo!!!bar"), "foo-bar");
  assert.equal(sanitizeName("--leading--"), "leading");
  assert.equal(sanitizeName("multi   spaces"), "multi-spaces");
});

test("titleCase: short tokens go uppercase, longer tokens get space-separated capitalization", () => {
  assert.equal(titleCase("work"), "WORK");
  assert.equal(titleCase("work"), "WORK");
  assert.equal(titleCase("client-acme"), "Client Acme");
  assert.equal(titleCase("personal-account"), "Personal Account");
});

test("expandHome and tildify are inverses for tilde paths", () => {
  const home = os.homedir();
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("~/foo/bar"), path.join(home, "foo/bar"));
  assert.equal(tildify(home), "~");
  assert.equal(tildify(path.join(home, "foo/bar")), "~/foo/bar");
  // Non-tilde paths pass through.
  assert.equal(expandHome("/etc/hosts"), "/etc/hosts");
  assert.equal(tildify("/etc/hosts"), "/etc/hosts");
});

// ---------------------------------------------------------------------------
// shell.js - alias line building
// ---------------------------------------------------------------------------

import { buildAliasLine } from "../src/shell.js";

test("buildAliasLine produces zsh/bash-style alias with quoted env var", () => {
  const line = buildAliasLine("zsh", "claude-work", "/Users/x/.claude-work");
  assert.equal(line, `alias claude-work='CLAUDE_CONFIG_DIR="/Users/x/.claude-work" claude'`);
});

test("buildAliasLine adds GH_CONFIG_DIR only when gh isolation is on", () => {
  const withGh = buildAliasLine(
    "zsh",
    "claude-work",
    "/Users/x/.claude-work",
    "/Users/x/.claude-work/gh"
  );
  assert.equal(
    withGh,
    `alias claude-work='CLAUDE_CONFIG_DIR="/Users/x/.claude-work" GH_CONFIG_DIR="/Users/x/.claude-work/gh" claude'`
  );

  // Omitting it must produce exactly the pre-0.1.16 line, so existing
  // profiles are untouched by the feature.
  const withoutGh = buildAliasLine("zsh", "claude-work", "/Users/x/.claude-work");
  assert.equal(
    withoutGh,
    `alias claude-work='CLAUDE_CONFIG_DIR="/Users/x/.claude-work" claude'`
  );
  assert.ok(!withoutGh.includes("GH_CONFIG_DIR"));

  // Fish takes the same treatment through its function syntax.
  const fish = buildAliasLine("fish", "claude-work", "/c", "/c/gh");
  assert.match(fish, /^function claude-work; CLAUDE_CONFIG_DIR="\/c" GH_CONFIG_DIR="\/c\/gh" claude \$argv; end$/);
});

test("canEnableGh: a complete profile can still gain gh isolation", async () => {
  const { canEnableGh } = await import("../src/commands/add.js");
  // The reported case: profile has both halves but predates gh isolation, so
  // `add` must not refuse the name outright.
  const complete = { name: "ipsy", desktop: {}, code: { configDir: "/c" } };
  assert.equal(canEnableGh(complete, true), true);
  // Already isolated: nothing left to offer.
  assert.equal(
    canEnableGh({ ...complete, code: { configDir: "/c", ghConfigDir: "/c/gh" } }, true),
    false
  );
  // No Code half, or no gh installed: not applicable.
  assert.equal(canEnableGh({ name: "x", desktop: {}, code: null }, true), false);
  assert.equal(canEnableGh(complete, false), false);
});

test("buildLaunchAppleScript: emits both env vars, each independently optional", () => {
  const APP2 = "/Applications/Claude.app";
  const both = buildLaunchAppleScript("/data", APP2, "/c", "/c/gh");
  assert.ok(both.includes("--env 'CLAUDE_CONFIG_DIR=/c'"));
  assert.ok(both.includes("--env 'GH_CONFIG_DIR=/c/gh'"));
  // Every --env has to precede --args or open passes it to the app as argv.
  assert.ok(both.lastIndexOf("--env") < both.indexOf("--args"));

  // gh omitted: unchanged from 0.1.15 output.
  const codeOnly = buildLaunchAppleScript("/data", APP2, "/c");
  assert.ok(codeOnly.includes("CLAUDE_CONFIG_DIR=/c"));
  assert.ok(!codeOnly.includes("GH_CONFIG_DIR"));

  // Neither: the original pre-0.1.12 line.
  assert.ok(!buildLaunchAppleScript("/data", APP2).includes("--env"));
});

test("ghTokenOverride: reports the variable that would defeat per-profile gh config", async () => {
  const { ghTokenOverride, defaultGhConfigDirFor } = await import("../src/code.js");
  assert.equal(ghTokenOverride({}), null);
  assert.equal(ghTokenOverride({ GH_TOKEN: "x" }), "GH_TOKEN");
  assert.equal(ghTokenOverride({ GITHUB_TOKEN: "x" }), "GITHUB_TOKEN");
  assert.equal(ghTokenOverride({ GH_ENTERPRISE_TOKEN: "x" }), "GH_ENTERPRISE_TOKEN");
  // An empty value is not an override.
  assert.equal(ghTokenOverride({ GH_TOKEN: "" }), null);
  // gh config nests inside the profile so rename/remove carry it for free.
  assert.equal(defaultGhConfigDirFor("/Users/x/.claude-work"), "/Users/x/.claude-work/gh");
});

test("buildAliasLine produces a fish function for fish", () => {
  const line = buildAliasLine("fish", "claude-work", "/home/x/.claude-work");
  assert.match(line, /^function claude-work;/);
  assert.match(line, /CLAUDE_CONFIG_DIR="\/home\/x\/\.claude-work"/);
  assert.match(line, /\$argv/);
});

// ---------------------------------------------------------------------------
// shell.js - managed-block round-tripping in a sandboxed HOME
// ---------------------------------------------------------------------------
//
// To avoid stomping on the test runner's own dotfiles, we set up a fake
// HOME under a temp directory and re-import shell.js with that HOME. We
// can't easily change HOME after util.js has captured it, so we instead
// test via the lower-level functions that operate on absolute paths.

import { readManagedAliases, writeAliases, rcPathForShell } from "../src/shell.js";

test("writeAliases creates a managed block when none exists, and replaces it on subsequent writes", async (t) => {
  // We override $HOME for this test by reaching into the rc-path resolver
  // and writing directly to the file it returns. Because rcPathForShell
  // computes its path from os.homedir() every call, setting HOME up front
  // would only work if we could reload the modules. Easier: write to a
  // manually constructed path under a tmpdir and call writeAliases with
  // a stubbed HOME.
  //
  // Since shell.js uses the captured HOME from util.js, we work around
  // this in a test-only way: write a fake .zshrc into HOME, snapshot it,
  // run our test, then restore. We use a marker so we never touch unrelated
  // content even on a developer machine.

  const rc = rcPathForShell("zsh");
  const original = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : null;
  t.after(() => {
    if (original === null) {
      try { fs.unlinkSync(rc); } catch {}
    } else {
      fs.writeFileSync(rc, original, "utf8");
    }
  });

  // First write - block does not yet exist.
  writeAliases("zsh", [
    `alias claude-a='CLAUDE_CONFIG_DIR="$HOME/.claude-a" claude'`,
  ]);
  let aliases = readManagedAliases("zsh");
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].name, "claude-a");

  // Second write - block exists, should be replaced not duplicated.
  writeAliases("zsh", [
    `alias claude-a='CLAUDE_CONFIG_DIR="$HOME/.claude-a" claude'`,
    `alias claude-b='CLAUDE_CONFIG_DIR="$HOME/.claude-b" claude'`,
  ]);
  aliases = readManagedAliases("zsh");
  assert.equal(aliases.length, 2);
  assert.deepEqual(
    aliases.map((a) => a.name).sort(),
    ["claude-a", "claude-b"]
  );

  // The file should still contain only one start/end pair, not stacked ones.
  const content = fs.readFileSync(rc, "utf8");
  const startMatches = content.match(/# >>> claude-multiprofile >>>/g) || [];
  const endMatches = content.match(/# <<< claude-multiprofile <<</g) || [];
  assert.equal(startMatches.length, 1);
  assert.equal(endMatches.length, 1);
});

// ---------------------------------------------------------------------------
// permissions.js - cross-profile read protection (issue #4)
// ---------------------------------------------------------------------------
//
// This is the riskiest new code because it edits a file the user also owns
// (settings.json). The invariants that matter: we must block every sibling,
// we must never eat the user's own deny rules, and repeated runs must not
// accumulate stale rules when the profile set changes.

import { resyncDenyRules, auditDenyRules, settingsPathFor } from "../src/permissions.js";

function tmpProfile(name, root) {
  const configDir = path.join(root, `.claude-${name}`);
  fs.mkdirSync(configDir, { recursive: true });
  return {
    name,
    type: "code",
    code: { configDir, aliasName: `claude-${name}` },
    desktop: null,
  };
}

function readSettings(configDir) {
  return JSON.parse(fs.readFileSync(settingsPathFor(configDir), "utf8"));
}

test("resyncDenyRules: each profile denies reads of every sibling, using absolute // syntax", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);
  resyncDenyRules({ profiles: [a, b] });

  const denyA = readSettings(a.code.configDir).permissions.deny;
  const denyB = readSettings(b.code.configDir).permissions.deny;

  // Absolute paths in Claude Code settings require a DOUBLE leading slash;
  // a single slash would resolve relative to the settings source instead.
  assert.equal(denyA.length, 1);
  assert.match(denyA[0], /^Read\(\/\//);
  assert.ok(denyA[0].includes(".claude-beta"), "alpha must block beta");
  assert.ok(!denyA[0].includes(".claude-alpha"), "alpha must not block itself");
  assert.ok(denyB[0].includes(".claude-alpha"), "beta must block alpha");

  fs.rmSync(root, { recursive: true, force: true });
});

test("resyncDenyRules: preserves user-authored deny rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);

  // User already had their own rule plus unrelated settings.
  fs.writeFileSync(
    settingsPathFor(a.code.configDir),
    JSON.stringify({ model: "opus", permissions: { deny: ["Read(//etc/secrets/**)"] } }),
    "utf8"
  );

  resyncDenyRules({ profiles: [a, b] });
  const s = readSettings(a.code.configDir);

  assert.ok(s.permissions.deny.includes("Read(//etc/secrets/**)"), "user rule survives");
  assert.equal(s.model, "opus", "unrelated settings survive");
  assert.ok(s.permissions.deny.some((r) => r.includes(".claude-beta")), "managed rule added");

  fs.rmSync(root, { recursive: true, force: true });
});

test("resyncDenyRules: drops stale rules when a profile goes away, and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);
  const c = tmpProfile("gamma", root);

  resyncDenyRules({ profiles: [a, b, c] });
  assert.equal(readSettings(a.code.configDir).permissions.deny.length, 2);

  // Running again with the same set must not duplicate anything.
  resyncDenyRules({ profiles: [a, b, c] });
  assert.equal(readSettings(a.code.configDir).permissions.deny.length, 2);

  // gamma removed -> alpha should no longer reference it.
  resyncDenyRules({ profiles: [a, b] });
  const deny = readSettings(a.code.configDir).permissions.deny;
  assert.equal(deny.length, 1);
  assert.ok(!deny.some((r) => r.includes(".claude-gamma")), "stale rule removed");

  fs.rmSync(root, { recursive: true, force: true });
});

test("resyncDenyRules: never overwrites a malformed settings.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);

  // A trailing comma: real content, invalid JSON. One resync treating this
  // as empty would replace the user's whole file with just our rules.
  const broken = `{ "model": "opus", }`;
  fs.writeFileSync(settingsPathFor(a.code.configDir), broken, "utf8");

  const results = resyncDenyRules({ profiles: [a, b] });

  const after = fs.readFileSync(settingsPathFor(a.code.configDir), "utf8");
  assert.equal(after, broken, "malformed file must be byte-identical");
  assert.ok(
    results.some((r) => r.name === "alpha" && r.skipped === "malformed"),
    "skip is reported"
  );
  // The healthy sibling still gets its rules.
  assert.ok(
    readSettings(b.code.configDir).permissions.deny.some((r) => r.includes(".claude-alpha"))
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("resyncDenyRules: refuses to write through a settings.json symlink", async () => {
  const { stripManagedDenyRules } = await import("../src/permissions.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);

  // Simulate a user sharing config: the profile's settings.json is a link to
  // a file outside the profile. Writing through it would put alpha's
  // per-profile deny rules into shared config that beta also reads.
  const shared = path.join(root, "shared-settings.json");
  fs.writeFileSync(shared, JSON.stringify({ model: "opus" }), "utf8");
  fs.symlinkSync(shared, settingsPathFor(a.code.configDir));

  const results = resyncDenyRules({ profiles: [a, b] });

  assert.deepEqual(
    JSON.parse(fs.readFileSync(shared, "utf8")),
    { model: "opus" },
    "shared target must not be mutated"
  );
  assert.ok(
    fs.lstatSync(settingsPathFor(a.code.configDir)).isSymbolicLink(),
    "the link itself is left alone"
  );
  assert.ok(results.some((r) => r.name === "alpha" && r.skipped === "symlink"));
  // The healthy sibling is unaffected.
  assert.ok(
    readSettings(b.code.configDir).permissions.deny.some((r) => r.includes(".claude-alpha"))
  );

  // stripManagedDenyRules honours the same boundary.
  assert.equal(stripManagedDenyRules(a), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(shared, "utf8")), { model: "opus" });

  fs.rmSync(root, { recursive: true, force: true });
});

test("settingsWriteSafety: a symlink that stays inside the profile is allowed", async () => {
  const { settingsWriteSafety } = await import("../src/permissions.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const p = tmpProfile("alpha", root);
  const dir = p.code.configDir;

  // No file yet: safe to create.
  assert.equal(settingsWriteSafety(dir).safe, true);

  // A link pointing elsewhere inside the same profile dir is harmless.
  const inner = path.join(dir, "real-settings.json");
  fs.writeFileSync(inner, "{}", "utf8");
  fs.symlinkSync(inner, settingsPathFor(dir));
  assert.equal(settingsWriteSafety(dir).safe, true, "internal link is fine");

  // Repoint it outside the profile: now it's refused.
  fs.rmSync(settingsPathFor(dir));
  const outside = path.join(root, "elsewhere.json");
  fs.writeFileSync(outside, "{}", "utf8");
  fs.symlinkSync(outside, settingsPathFor(dir));
  const verdict = settingsWriteSafety(dir);
  assert.equal(verdict.safe, false);
  assert.equal(verdict.reason, "symlink");

  // A broken link is refused too, rather than silently creating the target.
  fs.rmSync(settingsPathFor(dir));
  fs.symlinkSync(path.join(root, "does-not-exist.json"), settingsPathFor(dir));
  assert.equal(settingsWriteSafety(dir).reason, "broken-symlink");

  fs.rmSync(root, { recursive: true, force: true });
});

test("stripManagedDenyRules: removes our rules and marker, keeps the user's", async () => {
  const { stripManagedDenyRules } = await import("../src/permissions.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);

  // Seed managed rules, plus a user-authored rule on top.
  resyncDenyRules({ profiles: [a, b] });
  const p = settingsPathFor(a.code.configDir);
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  s.permissions.deny.push("Read(//etc/secrets/**)");
  fs.writeFileSync(p, JSON.stringify(s), "utf8");

  assert.equal(stripManagedDenyRules(a), true);
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.deepEqual(after.permissions.deny, ["Read(//etc/secrets/**)"], "only user rule remains");
  assert.ok(!("claudeMultiprofileManagedDeny" in after), "marker removed");

  // Second strip is a no-op.
  assert.equal(stripManagedDenyRules(a), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test("auditDenyRules: reports drift when a managed rule is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-perm-"));
  const a = tmpProfile("alpha", root);
  const b = tmpProfile("beta", root);
  const reg = { profiles: [a, b] };

  // Nothing written yet -> alpha is missing its rule.
  let findings = auditDenyRules(reg);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].missing.length, 1);

  resyncDenyRules(reg);
  findings = auditDenyRules(reg);
  assert.ok(findings.every((f) => f.missing.length === 0), "no drift after resync");

  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// registry.js - corruption guard, backup, replaceProfile
// ---------------------------------------------------------------------------
//
// registry.js captures XDG_CONFIG_HOME at first import, so we sandbox it
// HERE, in module scope, before any test dynamically imports the module.
// None of this file's static imports pull registry.js in (permissions.js
// deliberately takes the registry as an argument), so the first load happens
// inside a test, after this line has run.

const REGISTRY_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-reg-"));
process.env.XDG_CONFIG_HOME = REGISTRY_SANDBOX;

const registryFile = () =>
  path.join(REGISTRY_SANDBOX, "claude-multiprofile", "profiles.json");

test("registry: corrupt file reads as empty but refuses to be overwritten", async () => {
  const reg = await import("../src/registry.js");

  // Sanity: the sandbox took.
  assert.equal(reg.registryLocation(), registryFile());

  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), "{ this is not json", "utf8");

  assert.equal(reg.registryHealth().state, "corrupt");
  assert.equal(reg.getRegistry().profiles.length, 0, "read-only callers see empty");

  // Any mutation must throw, not clobber.
  assert.throws(
    () => reg.addToRegistry({ name: "x", type: "code", code: null, desktop: null }),
    /not valid JSON/
  );
  assert.equal(
    fs.readFileSync(registryFile(), "utf8"),
    "{ this is not json",
    "corrupt file untouched"
  );

  fs.rmSync(registryFile());
});

test("registry: writes back up the previous good file, replaceProfile swaps in place", async () => {
  const reg = await import("../src/registry.js");

  const mk = (name) => ({ name, type: "code", code: { configDir: `/tmp/${name}` }, desktop: null });
  reg.addToRegistry(mk("one"));
  reg.addToRegistry(mk("two")); // second write: backs up the first
  const bak = registryFile() + ".bak";
  assert.ok(fs.existsSync(bak), ".bak created on rewrite");
  assert.equal(JSON.parse(fs.readFileSync(bak, "utf8")).profiles.length, 1);

  // replaceProfile keeps position and count.
  reg.replaceProfile("one", mk("renamed"));
  const profiles = reg.getRegistry().profiles;
  assert.deepEqual(profiles.map((p) => p.name), ["renamed", "two"]);

  fs.rmSync(path.dirname(registryFile()), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// rename.js - path planning
// ---------------------------------------------------------------------------

test("planRenamePaths: default-located paths move, custom paths stay", async () => {
  const { planRenamePaths } = await import("../src/commands/rename.js");
  const { defaultConfigDirFor, defaultAliasNameFor } = await import("../src/code.js");
  const { defaultDataDirFor, defaultAppPathFor } = await import("../src/desktop.js");

  // Everything at defaults: all four artifacts are planned for a move.
  const allDefault = {
    name: "old",
    code: { configDir: defaultConfigDirFor("old"), aliasName: defaultAliasNameFor("old") },
    desktop: { dataDir: defaultDataDirFor("old"), appPath: defaultAppPathFor("old") },
  };
  const moved = planRenamePaths(allDefault, "old", "new");
  assert.equal(moved.plan.length, 4);
  assert.equal(moved.newCode.configDir, defaultConfigDirFor("new"));
  assert.equal(moved.newCode.aliasName, defaultAliasNameFor("new"));
  assert.equal(moved.newDesktop.dataDir, defaultDataDirFor("new"));
  assert.equal(moved.newDesktop.appPath, defaultAppPathFor("new"));

  // Custom paths: nothing moves except nothing at all.
  const allCustom = {
    name: "old",
    code: { configDir: "/opt/claude/work", aliasName: "cw" },
    desktop: { dataDir: "/Volumes/X/claude", appPath: "/Volumes/X/Claude W.app" },
  };
  const kept = planRenamePaths(allCustom, "old", "new");
  assert.equal(kept.plan.length, 0);
  assert.equal(kept.newCode.configDir, "/opt/claude/work");
  assert.equal(kept.newDesktop.appPath, "/Volumes/X/Claude W.app");
});

// ---------------------------------------------------------------------------
// desktop.js - reading CLAUDE_CONFIG_DIR back out of a compiled launcher
// ---------------------------------------------------------------------------
//
// doctor uses this to find launchers built before v0.1.12, which do not export
// CLAUDE_CONFIG_DIR and so leak Desktop-spawned Claude Code sessions into the
// shared ~/.claude. We compile real bundles here rather than stub the parser,
// because the round trip through osacompile/osadecompile is the part that can
// actually break.

test("launcherCodeConfigDir: reads the env back out of a real compiled launcher", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("osacompile is macOS only");
    return;
  }
  const { compileApp, launcherCodeConfigDir } = await import("../src/desktop.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const claudeApp = "/Applications/Claude.app"; // path is only embedded, not resolved
  const dataDir = path.join(root, "data");

  // Pre-v0.1.12 shape: no Code target, so no --env at all.
  const noEnv = path.join(root, "NoEnv.app");
  compileApp({ name: "noenv", dataDir, appPath: noEnv, claudeAppPath: claudeApp });
  assert.equal(launcherCodeConfigDir(noEnv), null, "no --env reads as null");

  // Current shape: the config dir round-trips exactly.
  const withEnv = path.join(root, "WithEnv.app");
  const cfg = path.join(root, ".claude-work");
  compileApp({
    name: "withenv",
    dataDir,
    appPath: withEnv,
    claudeAppPath: claudeApp,
    codeConfigDir: cfg,
  });
  assert.equal(launcherCodeConfigDir(withEnv), cfg, "config dir round-trips");

  // An apostrophe in the path is shell-escaped on the way in and must come
  // back out unescaped, not mangled.
  const quoted = path.join(root, "Quoted.app");
  const oddCfg = path.join(root, "o'brien-config");
  compileApp({
    name: "quoted",
    dataDir,
    appPath: quoted,
    claudeAppPath: claudeApp,
    codeConfigDir: oddCfg,
  });
  assert.equal(launcherCodeConfigDir(quoted), oddCfg, "apostrophe survives the round trip");

  // Not a bundle at all.
  assert.equal(launcherCodeConfigDir(path.join(root, "missing.app")), undefined);
});

// ---------------------------------------------------------------------------
// add.js - completing a half-built profile
// ---------------------------------------------------------------------------
//
// The case: a Desktop-only profile created before the user cared about Claude
// Code. `add` used to refuse the name outright, leaving no way to finish the
// profile. Now an existing name is only an error when there is genuinely
// nothing left to add.

test("missingTargets: an existing name is only taken when nothing is left to add", async () => {
  const { missingTargets } = await import("../src/commands/add.js");
  const desktopOnly = { name: "ipsy", desktop: {}, code: null };
  const codeOnly = { name: "work", desktop: null, code: {} };
  const both = { name: "full", desktop: {}, code: {} };

  // The reported case: Desktop profile exists, user asks for Code.
  assert.deepEqual(
    missingTargets(desktopOnly, { wantsDesktop: false, wantsCode: true }),
    ["code"]
  );
  // Asking for both should link only the half that is missing.
  assert.deepEqual(
    missingTargets(desktopOnly, { wantsDesktop: true, wantsCode: true }),
    ["code"]
  );
  assert.deepEqual(
    missingTargets(codeOnly, { wantsDesktop: true, wantsCode: true }),
    ["desktop"]
  );
  // Nothing missing means the name really is taken.
  assert.deepEqual(missingTargets(both, { wantsDesktop: true, wantsCode: true }), []);
  assert.deepEqual(
    missingTargets(desktopOnly, { wantsDesktop: true, wantsCode: false }),
    [],
    "asking only for the half it already has is a genuine collision"
  );
});

// ---------------------------------------------------------------------------
// doctor.js - resolving a package's declared executables
// ---------------------------------------------------------------------------
//
// A present package.json is not proof the command works. Claude Code 2.1.240
// shipped a case where the manifest was perfect, the native binary was
// downloaded, and `bin/claude.exe` was still the "not installed" stub at mode
// 644, so `claude` failed with `permission denied` while every structural
// check passed.

test("parseReportedVersion: pulls the version out of decorated --version output", async () => {
  const { parseReportedVersion } = await import("../src/commands/doctor.js");
  // The real case: the command reports a build that does not match its package.
  assert.equal(parseReportedVersion("2.1.126 (Claude Code)"), "2.1.126");
  assert.equal(parseReportedVersion("v1.2.3"), "1.2.3");
  assert.equal(parseReportedVersion("0.1.19\n"), "0.1.19");
  assert.equal(parseReportedVersion("tool version 10.20.30 (build abc)"), "10.20.30");
  // Two-part versions still count.
  assert.equal(parseReportedVersion("1.2"), "1.2");
  // Nothing version-shaped is a normal outcome, not an error.
  assert.equal(parseReportedVersion("no version here"), null);
  assert.equal(parseReportedVersion(""), null);
  assert.equal(parseReportedVersion(null), null);
});

test("binTargetsFor: handles both npm bin shapes and ignores junk", async () => {
  const { binTargetsFor } = await import("../src/commands/doctor.js");

  // Map form, which is what Claude Code uses.
  assert.deepEqual(
    binTargetsFor("/pkg/claude-code", { name: "@anthropic-ai/claude-code", bin: { claude: "bin/claude.exe" } }),
    { claude: "/pkg/claude-code/bin/claude.exe" }
  );

  // String form: one command, named after the package.
  assert.deepEqual(
    binTargetsFor("/pkg/thing", { name: "thing", bin: "cli.js" }),
    { thing: "/pkg/thing/cli.js" }
  );

  // String form with no name falls back to the directory name.
  assert.deepEqual(binTargetsFor("/pkg/fallback", { bin: "run.js" }), {
    fallback: "/pkg/fallback/run.js",
  });

  // No bin, or shapes npm would never produce, yield nothing rather than
  // throwing partway through a health check.
  assert.deepEqual(binTargetsFor("/pkg/x", {}), {});
  assert.deepEqual(binTargetsFor("/pkg/x", { bin: null }), {});
  assert.deepEqual(binTargetsFor("/pkg/x", { bin: ["a"] }), {});
  assert.deepEqual(binTargetsFor("/pkg/x", { bin: { a: "" } }), {});
});

// ---------------------------------------------------------------------------
// appclone.js - per-profile coloured Claude clones (issue #2)
// ---------------------------------------------------------------------------

test("appclone: colour table and clone paths", async () => {
  const c = await import("../src/appclone.js");
  assert.ok(c.isColor("teal"));
  assert.ok(!c.isColor("mauve"));
  assert.ok(!c.isColor(null));
  // Every colour is a hue rotation in degrees, so they must be numeric and
  // inside one turn or CIHueAdjust gets a meaningless angle.
  for (const [name, deg] of Object.entries(c.COLORS)) {
    assert.equal(typeof deg, "number", `${name} must be numeric`);
    assert.ok(deg >= 0 && deg < 360, `${name} must be a valid hue`);
  }
  // Clones live outside ~/Applications so they do not clutter the app list;
  // the launcher is the thing meant to be visible.
  assert.match(c.clonePathFor("work"), /claude-multiprofile\/apps\/Claude work\.app$/);
  assert.ok(!c.clonePathFor("work").includes("/Applications/Claude.app"));
});

test("appclone: a missing clone counts as stale, so it gets rebuilt", async (t) => {
  const c = await import("../src/appclone.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-clone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const absent = path.join(root, "Nope.app");
  assert.equal(c.cloneIsStale(absent, "/Applications/Claude.app"), true);

  // Two bundles with no readable version: we cannot tell, so leave it alone
  // rather than re-cloning 800MB on every doctor run.
  const a = path.join(root, "A.app");
  const b = path.join(root, "B.app");
  fs.mkdirSync(path.join(a, "Contents"), { recursive: true });
  fs.mkdirSync(path.join(b, "Contents"), { recursive: true });
  assert.equal(c.cloneIsStale(a, b), false, "unknown versions must not force a rebuild");
});

// ---------------------------------------------------------------------------
// claudebin.js - which output parsing
// ---------------------------------------------------------------------------

import { parseWhichOutput } from "../src/claudebin.js";

test("parseWhichOutput: preserves order, drops duplicates and blanks", () => {
  const out = "/a/claude\n/b/claude\n/a/claude\n\n  \n/c/claude\n";
  assert.deepEqual(parseWhichOutput(out), ["/a/claude", "/b/claude", "/c/claude"]);
  assert.deepEqual(parseWhichOutput(""), []);
});

// ---------------------------------------------------------------------------
// shell.js - empty managed block removal
// ---------------------------------------------------------------------------

test("writeAliases with an empty list removes the managed block entirely", async (t) => {
  const rc = rcPathForShell("zsh");
  const original = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : null;
  t.after(() => {
    if (original === null) {
      try { fs.unlinkSync(rc); } catch {}
    } else {
      fs.writeFileSync(rc, original, "utf8");
    }
  });

  writeAliases("zsh", [`alias claude-x='CLAUDE_CONFIG_DIR="$HOME/.claude-x" claude'`]);
  assert.equal(readManagedAliases("zsh").length, 1);

  // Removing the last alias should take the whole block, markers included.
  writeAliases("zsh", []);
  const content = fs.readFileSync(rc, "utf8");
  assert.ok(!content.includes("# >>> claude-multiprofile >>>"), "start marker gone");
  assert.ok(!content.includes("# <<< claude-multiprofile <<<"), "end marker gone");
  assert.equal(readManagedAliases("zsh").length, 0);
});

// ---------------------------------------------------------------------------
// desktop.js - launcher AppleScript, including CLAUDE_CONFIG_DIR injection
// ---------------------------------------------------------------------------

import { buildLaunchAppleScript } from "../src/desktop.js";

const APP = "/Applications/Claude.app";
const DIR = "/Users/x/Library/Application Support/Claude-WORK";

test("buildLaunchAppleScript: without a code config dir, no --env is emitted (upstream behaviour)", () => {
  const s = buildLaunchAppleScript(DIR, APP);
  assert.ok(s.includes("open -n -a '/Applications/Claude.app'"));
  assert.ok(s.includes(`--user-data-dir='${DIR}'`));
  assert.ok(!s.includes("--env"), "no --env when the profile has no Code target");
});

test("buildLaunchAppleScript: with a code config dir, --env precedes --args", () => {
  const s = buildLaunchAppleScript(DIR, APP, "/Users/x/.claude-work");
  assert.ok(s.includes("--env 'CLAUDE_CONFIG_DIR=/Users/x/.claude-work'"));
  // `open` requires --env BEFORE --args; everything after --args goes to argv.
  assert.ok(
    s.indexOf("--env") < s.indexOf("--args"),
    "--env must come before --args or open passes it to the app as an argument"
  );
});

test("buildLaunchAppleScript: single quotes in the config dir are escaped for both layers", () => {
  const s = buildLaunchAppleScript(DIR, APP, "/Users/o'brien/.claude-work");
  // The path crosses two quoting layers: POSIX shell single quotes, and the
  // AppleScript string literal wrapping the whole command. The shell escape
  // is '\'' , and its backslash must itself be doubled for AppleScript or
  // osacompile rejects \' as an unknown escape. So the source carries '\\'' .
  // (The end-to-end proof that this compiles and reads back is the
  // launcherCodeConfigDir round-trip test above.)
  assert.ok(s.includes("'\\\\''"), "apostrophe is escaped for the shell AND for AppleScript");
  assert.ok(!/[^\\]\\'/.test(s), "no bare \\' , which osacompile rejects");
});

test("buildLaunchAppleScript: an empty code config dir is treated as absent", () => {
  assert.ok(!buildLaunchAppleScript(DIR, APP, "").includes("--env"));
  assert.ok(!buildLaunchAppleScript(DIR, APP, undefined).includes("--env"));
});
