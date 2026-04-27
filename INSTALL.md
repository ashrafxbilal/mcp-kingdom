# Install Guide

This guide assumes you are using `mcp-graph` from a local clone.

## Prerequisites

- Node.js 20+
- `npm`
- OpenCode installed locally if you want to test OpenCode integration

If `opencode` is not on your `PATH`, use its full binary path instead.

## Clone And Build

```sh
git clone https://github.com/ashrafxbilal/mcp-graph.git
cd mcp-graph
npm install
npm run build
```

## Install `mcp-graph`

Install for all supported clients:

```sh
node dist/cli.js install
```

Install only for OpenCode:

```sh
node dist/cli.js install --targets opencode
```

The installer will:

- discover your existing backend MCPs
- write them to `~/.mcp-graph/backends.json`
- rewrite supported client configs so the front door is only `mcp-graph`
- create backups before overwriting config files

## What OpenCode Should Look Like After Install

After `node dist/cli.js install --targets opencode`:

- your active OpenCode config should contain only one enabled MCP entry: `mcp-graph`
- your previous OpenCode MCP servers should be preserved in `~/.mcp-graph/backends.json`
- OpenCode should launch `mcp-graph` from your local clone by absolute path
- OpenCode should not contain Claude-style permission keys like `mcp__server__tool`

If you need to override OpenCode MCP permissions manually, use OpenCode tool wildcards like `mcp-graph_*`. Do not use Claude/Codex-style `mcp__...` permission entries.

## OpenCode-Only Verification

Use this sequence if you want to test only OpenCode first.

### 1. Record the baseline

Before installing `mcp-graph`, capture:

```sh
opencode mcp list
opencode stats --days 1
```

What to note:

- how many MCP servers are currently enabled in OpenCode
- any servers already failing or requiring auth
- your current token totals for the day

### 2. Install only for OpenCode

From the `mcp-graph` repo:

```sh
node dist/cli.js install --targets opencode
```

### 3. Verify that OpenCode now loads only one front-door MCP

```sh
opencode mcp list
```

Expected result:

- `mcp-graph` should be the only active MCP server in OpenCode
- your old MCP servers should no longer be active directly inside OpenCode

This is the first structural proof that prompt context should shrink: OpenCode is no longer loading every backend MCP up front.

### 4. Verify that the backend snapshot still contains the original MCP inventory

```sh
MCP_GRAPH_CONFIG_PATH="$HOME/.mcp-graph/backends.json" node dist/cli.js inspect
```

For a broader smoke test:

```sh
MCP_GRAPH_CONFIG_PATH="$HOME/.mcp-graph/backends.json" node dist/cli.js inspect --tool-counts
```

What this proves:

- `inspect` proves the backend snapshot still contains your original MCP definitions
- `inspect --tool-counts` forces `mcp-graph` to fetch `tools/list` from each backend and count the tools

That second command is the fastest broad verification that backend MCP discovery is still working after the OpenCode rewrite.

### 5. Verify actual tool routing inside OpenCode

`inspect --tool-counts` proves backend discovery and tool listing. It does **not** prove that a real tool call succeeds on every backend.

To verify real routing inside OpenCode:

1. Start a fresh OpenCode session.
2. Ask OpenCode to use `mcp-graph` explicitly.
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

This is the most reliable proof that `mcp-graph` is doing the right thing.

After install:

- `opencode mcp list` should show only one active MCP: `mcp-graph`
- `MCP_GRAPH_CONFIG_PATH="$HOME/.mcp-graph/backends.json" node dist/cli.js inspect --tool-counts` should show:
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

- before `mcp-graph`, OpenCode has to load every active MCP tool surface into the session context
- after `mcp-graph`, OpenCode loads only six front-door tools and the backends stay behind the gateway until needed

Important nuance:

- the biggest savings should show up at session start and on prompts that do not need most MCPs
- if a prompt eventually drills into several backend tools, total end-to-end token savings may shrink because `mcp-graph` still has to reveal the relevant tools on demand

If your OpenCode build exposes per-session usage in exported session JSON, you can also compare individual sessions:

```sh
opencode export <session-id>
```

Use that only as a session-level supplement. The structural proof above is still the core signal.

## Rollback

The installer creates backups before overwriting client configs.

If you want to revert OpenCode only:

1. find the latest backup of your OpenCode config
2. restore it over the active OpenCode config
3. restart OpenCode

You can also remove the generated backend snapshot if you no longer need it:

```sh
rm -f "$HOME/.mcp-graph/backends.json"
```
