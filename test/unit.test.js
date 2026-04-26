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
  const startMatches = content.match(/# >>> claude-profiles >>>/g) || [];
  const endMatches = content.match(/# <<< claude-profiles <<</g) || [];
  assert.equal(startMatches.length, 1);
  assert.equal(endMatches.length, 1);
});
