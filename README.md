# mcp-graph

`mcp-graph` is a progressive-disclosure MCP gateway.

Instead of exposing every tool from every connected MCP server up front, `mcp-graph` exposes a small, stable tool surface and lazily indexes and proxies backend MCP servers only when the agent asks for them.

Supporting docs:

- [Install Guide](INSTALL.md)
- [Architecture](docs/architecture.md)
- [Trust Model](docs/trust-model.md)

## Why This Exists

When agents connect to many MCP servers directly, they pay for it twice:

- tool definitions get loaded up front
- large intermediate tool results bounce through the agent loop

`mcp-graph` keeps the top-level surface small and shifts backend tool discovery to runtime.

## What It Does

`mcp-graph` exposes only these tools:

- `list_servers`
- `search_tools`
- `get_tool_schema`
- `call_tool`
- `batch_call_tools`
- `refresh_cache`

Behind the scenes it can:

- discover MCP servers from existing Claude, Codex, and OpenCode config files
- merge duplicate server definitions with deterministic precedence
- connect lazily on first use
- cache backend tool lists in memory and on disk
- proxy stdio, streamable HTTP, and SSE MCP servers
- shape large tool results with output modes, field projection, and array limiting
- snapshot your existing MCP inventory into a dedicated backend config file
- rewrite supported client configs so they load only `mcp-graph`
- back up rewritten client config files before changing them
- expose inventory counts so you can verify how much tool surface moved behind the gateway

## Architecture

Recommended install model:

1. Snapshot your current MCP inventory into a backend file.
2. Reconfigure Claude Desktop / Claude Code / Codex / OpenCode to load only `mcp-graph`.
3. Let `mcp-graph` discover, search, and call the backend MCPs on demand.

This gives you token savings without depending on any external code-executor repo.

## Install

### Clone and build

```sh
git clone https://github.com/ashrafxbilal/mcp-graph.git
cd mcp-graph
npm install
npm run build
```

Then run the CLI locally:

```sh
node dist/cli.js --help
```

The installer rewrites supported client configs to point at this local clone by absolute path. It does not require a published npm package.

For client-specific setup and verification, see [INSTALL.md](INSTALL.md).

## Quick Start

### 1. Install from a local clone

```sh
git clone https://github.com/ashrafxbilal/mcp-graph.git
cd mcp-graph
npm install
npm run build
node dist/cli.js install
```

If you want to target specific clients:

```sh
node dist/cli.js install --targets claude,codex,opencode
```

This install command:

- discovers your existing MCPs from supported configs
- writes `~/.mcp-graph/backends.json`
- backs up and rewrites supported client configs so they point only to this local `mcp-graph` checkout

Supported install targets:

- Claude Desktop / Claude Code
- Codex
- OpenCode

### 2. Snapshot your current MCP inventory manually

```sh
node dist/cli.js snapshot --output ~/.mcp-graph/backends.json
```

This merges MCPs from the local machine into one backend file.

Default auto-discovery looks at:

- `.mcp.json` in the current working directory
- `opencode.json` in the current working directory
- `~/.claude/settings.json`
- `~/.claude/mcp.json`
- `~/.claude.json`
- `~/.config/opencode/opencode.json`
- `~/.opencode.json`
- `~/.codex/config.toml`

### 3. Configure a client manually if you do not use the installer

Example `~/.claude.json` entry:

```json
{
  "mcpServers": {
    "mcp-graph": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp-graph/dist/cli.js"],
      "env": {
        "MCP_GRAPH_CONFIG_PATH": "/Users/your-user/.mcp-graph/backends.json",
        "MCP_GRAPH_AUDIT_LOG_PATH": "/Users/your-user/.mcp-graph/audit.log"
      }
    }
  }
}
```

If you do this, remove the other MCP entries from the active top-level config. Otherwise the client still loads them directly and you lose the context-saving benefit.

### 4. Ask the agent to use `mcp-graph`

Typical flow:

1. `search_tools` with a narrow query
2. `get_tool_schema` only for the relevant match
3. `call_tool` or `batch_call_tools`

## Codex Integration

Codex can also point at `mcp-graph` instead of loading every MCP directly.

Example `~/.codex/config.toml` snippet:

```toml
[mcp_servers.mcp-graph]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/mcp-graph/dist/cli.js"]
env = { MCP_GRAPH_CONFIG_PATH = "/Users/your-user/.mcp-graph/backends.json", MCP_GRAPH_AUDIT_LOG_PATH = "/Users/your-user/.mcp-graph/audit.log" }
```

As with Claude, the token benefit comes only if `mcp-graph` is the primary active MCP surface.

## OpenCode Integration

OpenCode can load `mcp-graph` as a local MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-graph": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/mcp-graph/dist/cli.js"],
      "enabled": true,
      "environment": {
        "MCP_GRAPH_CONFIG_PATH": "/Users/your-user/.mcp-graph/backends.json",
        "MCP_GRAPH_AUDIT_LOG_PATH": "/Users/your-user/.mcp-graph/audit.log"
      }
    }
  }
}
```

As with Claude and Codex, the token benefit comes only if the other MCPs are moved behind the backend snapshot and `mcp-graph` is the only active front-door MCP.

Do not copy Claude-style permission keys like `mcp__server__tool` into OpenCode. OpenCode permissions use its own tool-name patterns, and MCP permissions should be expressed with OpenCode wildcards like `mcp-graph_*` only if you need to override the default behavior. By default, OpenCode already allows tools to run.

## CLI

### Run the server

```sh
node dist/cli.js
```

### Snapshot merged MCP config

```sh
node dist/cli.js snapshot --output ~/.mcp-graph/backends.json
```

### Inspect discovered servers and duplicate resolution

```sh
node dist/cli.js inspect
```

With backend tool counts:

```sh
node dist/cli.js inspect --tool-counts
```

### Install and rewrite supported clients

```sh
node dist/cli.js install
```

Options:

- `--targets claude,codex,opencode`
- `--backend /custom/path/backends.json`
- `--audit-log /custom/path/audit.log`
- `--dry-run`

## Environment Variables

- `MCP_GRAPH_CONFIG_PATH`: explicit backend config file(s). If set, `mcp-graph` uses these paths instead of auto-discovery.
- `MCP_GRAPH_INCLUDE_CODEX`: set to `false` to ignore `~/.codex/config.toml` during auto-discovery.
- `MCP_GRAPH_INCLUDE_DISABLED_OPENCODE`: set to `true` to include OpenCode MCP entries with `enabled: false`.
- `MCP_GRAPH_EXCLUDE_SERVERS`: comma-separated server names to ignore.
- `MCP_GRAPH_AUDIT_LOG_PATH`: optional JSONL audit log path.
- `MCP_GRAPH_CACHE_DIR`: override the persistent tool-index cache directory.
- `MCP_GRAPH_TOOL_CACHE_TTL_MS`: set the on-disk tool cache TTL in milliseconds.

## Duplicate Resolution

When the same server name appears in multiple configs, `mcp-graph` keeps one definition using this precedence:

1. explicit backend config path
2. project `.mcp.json`
3. project `opencode.json`
4. `~/.claude/mcp.json`
5. `~/.claude.json`
6. `~/.claude/settings.json`
7. `~/.config/opencode/opencode.json` / `~/.opencode.json`
8. `~/.codex/config.toml`

Within the same source tier, stdio entries beat remote entries because they are usually richer and more portable.

## Supported Backends

- stdio via `command` + `args`
- streamable HTTP via `url` and `type`/`transport`
- SSE via `type = "sse"`

## Smoke Test

```sh
npm run smoke-test
```

This spins up a local mock MCP backend, indexes it through `mcp-graph`, and verifies both tool discovery and proxy invocation.

## Test Matrix

```sh
npm run check
npm test
npm run test:coverage
npm run smoke-test
```

Current automated coverage includes:

- config discovery and duplicate resolution across Claude, Codex, and OpenCode
- install rewrites and backup behavior
- persistent on-disk tool index caching
- result shaping for large structured tool outputs
- GraphRegistry proxy behavior
- end-to-end stdio serving through the public CLI

## Limitations

- auth handshakes beyond static headers are not implemented yet
- `call_tool` returns truncated previews by default to reduce context growth
- this project is a gateway, not a code sandbox or workflow runtime
- tool counts in `inspect --tool-counts` and `list_servers(includeToolCounts=true)` still require contacting backends once to build the inventory

## Roadmap

- richer auth support for remote MCP servers
- opt-in subgraph policies for grouping or hiding backend tools
- optional workflow execution DSL on top of batch calls
- subprocess-aware coverage collection for CLI child-process paths

## Development

```sh
npm run check
npm test
npm run build
npm run smoke-test
```
