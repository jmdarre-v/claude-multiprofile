#!/usr/bin/env node
// Entry point for the `claude-profiles` command.
//
// This is intentionally tiny. All the real logic lives in src/cli.js,
// so the bin file just hands over argv and lets the CLI module take over.
//
// We slice argv to drop the first two entries (node binary + script path),
// because what the CLI cares about are the user-supplied arguments only.

import { run } from "../src/cli.js";

run(process.argv.slice(2));
