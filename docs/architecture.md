# Architecture

`mcp-graph` is designed around one constraint: keep the client-visible MCP surface small while preserving access to many backend MCP servers.

## Front-Door Design

The client connects to one MCP server: `mcp-graph`.

That front door exposes only:

- `list_servers`
- `search_tools`
- `get_tool_schema`
- `call_tool`
- `batch_call_tools`
- `refresh_cache`

Everything else stays behind the gateway until the agent explicitly asks for it.

## Request Flow

1. A client calls `search_tools` or `list_servers`.
2. `mcp-graph` loads backend definitions from supported local config files or explicit backend snapshots.
3. It connects to a backend only when that backend is actually needed.
4. Tool metadata is cached in memory for the current process and on disk for later sessions.
5. When the agent chooses a tool, `mcp-graph` proxies the call and returns a shaped preview by default.

This means the client sees a narrow top-level schema surface instead of every tool from every backend MCP.

## Discovery Model

Discovery precedence is deterministic:

1. explicit backend config path(s)
2. project `.mcp.json`
3. project `opencode.json`
4. `~/.claude/mcp.json`
5. `~/.claude.json`
6. `~/.claude/settings.json`
7. `~/.config/opencode/opencode.json` and `~/.opencode.json`
8. `~/.codex/config.toml`

Duplicate server names are resolved by precedence and transport preference.

## Cache Layers

There are two cache layers:

- in-memory cache: avoids repeated `tools/list` requests inside one `mcp-graph` process
- persistent disk cache: survives restarts and reduces repeated schema fetches across sessions

Cache files are fingerprinted against the backend config. If the backend definition changes, the old cache entry is ignored.

## Result Shaping

Large tool responses are one of the easiest ways to waste context after a gateway is in place.

`call_tool` therefore supports:

- `outputMode`: `content`, `structured`, or `full`
- `fieldPath`: project down into a nested field before returning
- `maxArrayItems`: cap arrays before serialization
- `maxCharacters`: truncate the final rendered preview

The default behavior is deliberately conservative: return a truncated text preview.

## Install Model

The installer snapshots all discovered backend MCPs into `~/.mcp-graph/backends.json`, generates a backend tool policy in `~/.mcp-graph/policy.json`, and then rewrites supported client configs so that they load only `mcp-graph`.

The generated policy is conservative:

- if a backend can be enumerated, its discovered tool list becomes the allow-listed runtime surface
- if a safe read-only tool with zero required arguments exists, the installer probes it and records the result
- if a backend cannot be enumerated, the policy falls back to passthrough mode for that server unless you install with `--strict-verify`
- connection resolution is dynamic: `mcp-graph` can retry known transport variants and record the selected strategy in policy/inspect output
- OAuth-gated backends stay behind `mcp-graph`; bootstrap their tokens with `node dist/cli.js auth login --server <name>`

Backups are created before overwriting existing client config files.

The token benefit depends on this install model. If the original MCPs stay active in the client, the gateway does not reduce the initial tool-schema load.

## Non-Goals

`mcp-graph` is not trying to be:

- an arbitrary code execution sandbox
- a general workflow engine
- a replacement trust boundary for unsafe MCPs

It is a discovery, proxy, and shaping layer for existing MCP servers.
