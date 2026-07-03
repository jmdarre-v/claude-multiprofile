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

import { sanitizeName, titleCase, expandHome, tildify } from "../src/util.js";

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
// code.js - safe symlink seeding
// ---------------------------------------------------------------------------

import {
  isShareable,
  shareableItemsIn,
  symlinkSelected,
} from "../src/code.js";

test("isShareable: excludes auth/identity + noise, allows arbitrary user items", () => {
  // auth / identity — always excluded (exact names and by pattern)
  for (const n of [".claude.json", ".credentials.json", "credentials.json",
    "auth.json", "my-token.txt", "api-secret", "server.pem", "id.key"]) {
    assert.equal(isShareable(n), false, `expected ${n} excluded`);
  }
  // cache / instance noise — excluded
  for (const n of ["statsig", "cache", "paste-cache", ".DS_Store",
    "foo-cache.json", "usage-stats.json", "daemon-1", "run.log"]) {
    assert.equal(isShareable(n), false, `expected ${n} excluded`);
  }
  // path traversal / bad names — excluded (blocklist can't be tricked)
  for (const n of ["..", ".", "../x", "a/b", "a\\b", ""]) {
    assert.equal(isShareable(n), false, `expected ${JSON.stringify(n)} excluded`);
  }
  // known-safe AND arbitrary user content — allowed (blocklist lets extras through)
  for (const n of ["skills", "plugins", "settings.json", "commands", "agents",
    "rules", "my-custom-dir", "notes.md"]) {
    assert.equal(isShareable(n), true, `expected ${n} shareable`);
  }
});

test("shareableItemsIn lists everything present except blocked items", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-src-"));
  fs.mkdirSync(path.join(src, "skills"));
  fs.mkdirSync(path.join(src, "my-custom-dir")); // user's own -> shared
  fs.writeFileSync(path.join(src, "settings.json"), "{}");
  fs.writeFileSync(path.join(src, ".credentials.json"), "secret"); // blocked
  fs.writeFileSync(path.join(src, ".claude.json"), "{}"); // blocked

  const items = shareableItemsIn(src);
  assert.ok(items.includes("skills"));
  assert.ok(items.includes("my-custom-dir"));
  assert.ok(items.includes("settings.json"));
  assert.ok(!items.includes(".credentials.json"));
  assert.ok(!items.includes(".claude.json"));
});

test("symlinkSelected links safe items, resolves to real target, REFUSES auth + traversal", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-src-"));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-dst-"));
  fs.mkdirSync(path.join(src, "skills"));
  fs.writeFileSync(path.join(src, "settings.json"), "{}");
  fs.writeFileSync(path.join(src, ".credentials.json"), "secret");

  const linked = symlinkSelected(
    dst,
    ["skills", "settings.json", ".credentials.json", "../escape"],
    src
  );

  assert.deepEqual(linked.sort(), ["settings.json", "skills"]);
  // link resolves to the real source (data genuinely shared, not copied)
  assert.equal(fs.readlinkSync(path.join(dst, "skills")), path.join(src, "skills"));
  assert.ok(fs.lstatSync(path.join(dst, "settings.json")).isSymbolicLink());
  // auth file + traversal target must never appear
  assert.ok(!fs.existsSync(path.join(dst, ".credentials.json")));
  assert.ok(!fs.existsSync(path.join(dst, "escape")));
});

test("symlinkSelected never destroys a real (non-symlink) dir at the destination", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-src-"));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-dst-"));
  fs.mkdirSync(path.join(src, "skills"));
  // real dir with user data already sitting where the link would go
  fs.mkdirSync(path.join(dst, "skills"));
  fs.writeFileSync(path.join(dst, "skills", "keep.txt"), "important");

  // Fails loud (EEXIST) rather than recursively deleting the real dir.
  assert.throws(() => symlinkSelected(dst, ["skills"], src));
  assert.equal(
    fs.readFileSync(path.join(dst, "skills", "keep.txt"), "utf8"),
    "important"
  );
});

test("symlinkSelected re-links idempotently when dst already holds a symlink", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-src-"));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-dst-"));
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-stale-"));
  fs.mkdirSync(path.join(src, "skills"));
  // a stale symlink from a prior run points somewhere else
  fs.symlinkSync(stale, path.join(dst, "skills"));

  // re-linking must not throw and must re-point at the real source
  const linked = symlinkSelected(dst, ["skills"], src);
  assert.deepEqual(linked, ["skills"]);
  assert.equal(fs.readlinkSync(path.join(dst, "skills")), path.join(src, "skills"));
});
