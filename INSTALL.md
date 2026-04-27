# Install Guide

This guide assumes you are using `mcp-kingdom` from a local clone.

## Prerequisites

- Node.js 20+
- `npm`
- OpenCode installed locally if you want to test OpenCode integration

If `opencode` is not on your `PATH`, use its full binary path instead.

## Clone And Build

```sh
git clone https://github.com/ashrafxbilal/mcp-kingdom.git
cd mcp-kingdom
npm install
npm run doctor
npm run setup
```

If you only want to build without rewriting local configs:

```sh
npm run build
```

## Install `mcp-kingdom`

Install for all supported clients:

```sh
npm run doctor
npm run setup
```

Install only for OpenCode:

```sh
npm run setup:opencode
```

Install only for Claude:

```sh
npm run setup:claude
```

Install only for Codex:

```sh
npm run setup:codex
```

The installer will:

- discover your existing backend MCPs
- collapse alias-only duplicates after successful verification when they resolve to the same backend and tool surface
- write them to `~/.mcp-kingdom/backends.json`
- write a backend tool policy to `~/.mcp-kingdom/policy.json`
- verify `tools/list` for every backend and safe-probe read-only tools when possible
- rewrite supported client configs so the front door is only `mcp-kingdom`
- trim Claude MCP permissions down to the `mcp-kingdom` front door only
- clean stale backend `mcp__server__tool` entries from `~/.claude/settings.local.json`
- create backups before overwriting config files

After install, you can run a broad verification pass with:

```sh
npm run verify
```

`npm run doctor` is the safe preflight:

- it does the same discovery and policy build as setup
- it prints which files would be created or updated
- it shows discovered backends, duplicate resolutions, and policy counts
- it does not mutate client configs or snapshots

You can also run it directly:

```sh
node dist/cli.js doctor --targets claude,codex,opencode
```

## What OpenCode Should Look Like After Install

After `node dist/cli.js install --targets opencode`:

- your active OpenCode config should contain only one enabled MCP entry: `mcp-kingdom`
- your previous OpenCode MCP servers should be preserved in `~/.mcp-kingdom/backends.json`
- your backend tool policy should exist in `~/.mcp-kingdom/policy.json`
- auth state for OAuth-gated backends will be stored in `~/.mcp-kingdom/auth`
- OpenCode should launch `mcp-kingdom` from your local clone by absolute path
- OpenCode should not contain Claude-style permission keys like `mcp__server__tool`

If you need to override OpenCode MCP permissions manually, use OpenCode tool wildcards like `mcp-kingdom_*`. Do not use Claude/Codex-style `mcp__...` permission entries.

## OpenCode-Only Verification

Use this sequence if you want to test only OpenCode first.

### 1. Record the baseline

Before installing `mcp-kingdom`, capture:

```sh
opencode mcp list
opencode stats --days 1
```

What to note:

- how many MCP servers are currently enabled in OpenCode
- any servers already failing or requiring auth
- your current token totals for the day

### 2. Install only for OpenCode

From the `mcp-kingdom` repo:

```sh
node dist/cli.js install --targets opencode
```

If you want the install to fail instead of falling back to passthrough mode when some backends cannot be enumerated, use:

```sh
node dist/cli.js install --targets opencode --strict-verify
```

### 3. Verify that OpenCode now loads only one front-door MCP

```sh
opencode mcp list
```

Expected result:

- `mcp-kingdom` should be the only active MCP server in OpenCode
- your old MCP servers should no longer be active directly inside OpenCode

This is the first structural proof that prompt context should shrink: OpenCode is no longer loading every backend MCP up front.

### 4. Verify that the backend snapshot still contains the original MCP inventory

```sh
node dist/cli.js inspect
```

For a broader smoke test:

```sh
node dist/cli.js inspect --tool-counts
```

What this proves:

- `inspect` proves the backend snapshot still contains your original MCP definitions
- after `install`, `inspect` automatically uses `~/.mcp-kingdom/backends.json` when your client configs have already been rewired to only `mcp-kingdom`
- `inspect --tool-counts` forces `mcp-kingdom` to fetch `tools/list` from each backend and count the tools
- `~/.mcp-kingdom/policy.json` records which servers were allow-listed, which fell back to passthrough, and whether a safe read-only probe succeeded
- the inspect output also shows the selected connection strategy and remediation for transport/auth failures

For Slack or other OAuth-gated MCPs:

```sh
node dist/cli.js auth login --server slack
```

That second command is the fastest broad verification that backend MCP discovery is still working after the OpenCode rewrite.

### 5. Verify actual tool routing inside OpenCode

`inspect --tool-counts` proves backend discovery and tool listing. It does **not** prove that a real tool call succeeds on every backend.

To verify real routing inside OpenCode:

1. Start a fresh OpenCode session.
2. Ask OpenCode to use `mcp-kingdom` explicitly.
3. For each backend you care about, repeat this sequence:

```text
Use list_servers with includeToolCounts=true and confirm that <backend> is present.
Use search_tools with server="<backend>" limit=10 and show me candidate tools.
Use get_tool_schema for the safest read-only tool on <backend>.
Use call_tool on that read-only tool with the smallest valid argument set.
```

Prefer read-only tools whose names start with verbs like:

- `list`
- `get`
- `search`
- `describe`
- `show`
- `status`

Avoid using tools that look destructive or side-effecting, such as:

- `create`
- `delete`
- `update`
- `trigger`
- `deploy`
- `run`

If you want to verify **all** backends, you need at least one successful read-only `call_tool` per backend. `list_servers` and `search_tools` alone are not enough for that claim.

## How To Verify Token Reduction In OpenCode

There are two different proofs:

### Structural proof

This is the most reliable proof that `mcp-kingdom` is doing the right thing.

After install:

- `opencode mcp list` should show only one active MCP: `mcp-kingdom`
- `MCP_KINGDOM_CONFIG_PATH="$HOME/.mcp-kingdom/backends.json" node dist/cli.js inspect --tool-counts` should show:
  - a small `frontDoorToolCount` of `6`
  - a much larger `totalBackendTools`

That means OpenCode only sees six top-level tools instead of the full backend MCP surface.

### Runtime proof

Use the same model, same project, and same prompt before and after the OpenCode install.

Suggested sequence:

1. Pick a disposable test directory.
2. Record current stats:

```sh
opencode stats --days 1 --project "$PWD"
```

3. Run a fresh session with a fixed prompt that does not require tools:

```sh
opencode run --dir "$PWD" "Reply with OK only."
```

4. Record stats again:

```sh
opencode stats --days 1 --project "$PWD"
```

5. Compare the token delta.

Why this works:

- before `mcp-kingdom`, OpenCode has to load every active MCP tool surface into the session context
- after `mcp-kingdom`, OpenCode loads only six front-door tools and the backends stay behind the gateway until needed

Important nuance:

- the biggest savings should show up at session start and on prompts that do not need most MCPs
- if a prompt eventually drills into several backend tools, total end-to-end token savings may shrink because `mcp-kingdom` still has to reveal the relevant tools on demand

If your OpenCode build exposes per-session usage in exported session JSON, you can also compare individual sessions:

```sh
opencode export <session-id>
```

Use that only as a session-level supplement. The structural proof above is still the core signal.

## Rollback

The installer creates backups before overwriting client configs.

## Claude Usage Comparisons

Compare today against the previous week:

```sh
npm run claude-stats
```

Compare a specific day against the previous 7 days:

```sh
npm run claude-stats -- --date 2026-04-27 --compare-days 7
```

Use a different timezone or log root:

```sh
node dist/cli.js claude-stats --date today --compare-days 7 --timezone Asia/Kolkata
node dist/cli.js claude-stats --root ~/.claude/projects --date 2026-04-27
```

The stats command reads local Claude JSONL logs from `~/.claude/projects` by default and reports:

- target-day totals
- previous-window totals and daily averages
- fresh-token and total-token comparisons
- a per-day breakdown for the requested window

## OpenCode Usage Comparisons

Compare today against the previous week:

```sh
npm run opencode-stats
```

Compare a specific day against the previous 7 days:

```sh
npm run opencode-stats -- --date 2026-04-27 --compare-days 7
```

Filter to a single project:

```sh
node dist/cli.js opencode-stats --project /absolute/project/path --date today
```

The stats command reads the local OpenCode SQLite database and reports:

- target-day totals
- previous-window totals and daily averages
- fresh-token, total-token, and cost comparisons
- a per-day breakdown for the requested window

## Adding New MCPs Later

If you add or remove MCPs after the first install:

```sh
npm run rediscover
npm run verify
```

`npm run rediscover` is the fast path after adding MCPs. It will rediscover whatever MCPs exist on that machine, refresh `~/.mcp-kingdom/backends.json`, regenerate the policy, and rewrite supported clients back to only `mcp-kingdom`.

This is why the repo works for other users with different MCP inventories too: discovery is local and dynamic, not hardcoded to your current machine.

If you want to revert OpenCode only:

1. find the latest backup of your OpenCode config
2. restore it over the active OpenCode config
3. restart OpenCode

You can also remove the generated backend snapshot if you no longer need it:

```sh
rm -f "$HOME/.mcp-kingdom/backends.json"
```
