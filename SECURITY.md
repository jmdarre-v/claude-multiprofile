# Security policy

claude-multiprofile keeps several Claude accounts apart on one Mac. The whole point is that one profile's account, conversations, credentials and GitHub login do not reach another. A bug that breaks that separation is a security bug, even when nothing crashes and nothing looks wrong.

## Supported versions

The project is pre-1.0 and ships small releases often, so only the latest release gets fixes. Upgrading is one command:

```
claude-multiprofile upgrade
```

| Version | Supported |
| ------- | --------- |
| Latest release on [npm](https://www.npmjs.com/package/claude-multiprofile) | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub instead: go to the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainer can see it.

Helpful to include:

- the claude-multiprofile version (`claude-multiprofile --version`), your macOS version, and your Claude Desktop and Claude Code versions
- the steps to reproduce it
- what an attacker, or a mistaken profile, could see or change as a result

What happens next:

- **Within 7 days:** an acknowledgement that it has been received.
- **Within 14 days:** an assessment, saying whether it is being treated as a vulnerability and roughly when a fix is expected.
- **When fixed:** a release, and a published GitHub security advisory that credits you, unless you would rather stay anonymous. You will see the advisory before it is published.
- **If it is declined:** an explanation of why. Declined reports that still point at a real problem usually become ordinary issues, with your agreement.

This is a one-maintainer project, so those times are commitments to respond, not guarantees of how long a fix takes.

## What counts

The most serious issues are the ones that break the separation between profiles, or put data somewhere it should not be:

- **One profile receiving another's data:** conversations, prompt history, credentials, MCP server configuration, or GitHub login. For example, before v0.1.31 seeding a new Code profile copied the default account's conversations into it.
- **The tool writing outside the places listed under [Security notes](README.md#security-notes)**, or following a symlink out of a profile.
- **Launchers or the launch helper running anything other than Claude.** The helper runs on every Dock click, so anything that lets it be pointed at another program matters.
- **Command or AppleScript injection** through profile names or paths. Launchers carry paths through two quoting layers (shell and AppleScript), which is exactly where this kind of bug lives.
- **Anything that exposes credentials**, including Keychain entries or account identity in `~/.claude.json`.
- **The npm package containing something that is not in this repository.**

## What does not count, or belongs elsewhere

- **Vulnerabilities in Claude Desktop, Claude Code or claude.ai themselves.** Please report those to Anthropic through its [responsible disclosure policy](https://www.anthropic.com/responsible-disclosure-policy).
- **Profiles are separated by configuration, not by a sandbox.** Anything running as your macOS user can read every profile's files. That is documented under [Profile isolation](README.md#profile-isolation). A report is welcome when one of the documented protections fails, such as the cross-profile read rules, not because the design does not sandbox.
- **Attacks that already require running code as your user.** That code can read your files with or without this tool.

## How the tool limits its own reach

- **Network:** it only ever contacts the npm registry, for `upgrade` and for `doctor`'s version check. The launch helper makes no network requests.
- **Keychain:** it never reads or writes Keychain entries. Claude Code keeps its sign-in there, and the tool leaves it alone.
- **Your default Claude:** it reads your default `~/.claude`, `~/.claude.json` and Desktop data folder where a feature needs to, and never writes to them.
- **Destructive steps ask first.** Conversations are only deleted if you tell `remove` to delete a profile's folders, and each of those confirmations defaults to no. `rename` and `remove` refuse while a profile is open. The launch helper only quits a Claude window after you confirm in a dialog.
- **Dependencies:** one direct runtime dependency, [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts), which brings 31 more packages with it. Everything else uses what ships with macOS: `osascript`, `osacompile`, `PlistBuddy`, `cp`, `ps`.
