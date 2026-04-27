# Trust Model

`mcp-graph` changes how MCPs are exposed to the client. It does not make an unsafe backend safe.

## What `mcp-graph` Does

- discovers backend MCP definitions
- generates a runtime policy from discovered backend tool lists
- proxies tool calls to those backends
- caches tool metadata
- rewrites local client configs so the gateway is the only active front door
- optionally writes audit logs for gateway activity

## What It Does Not Do

- sandbox backend MCP execution
- inspect or filter backend tool side effects
- negotiate interactive auth flows beyond static headers already present in config
- reduce the privileges of the original backend commands

If a backend MCP runs a local binary with full user privileges, that trust boundary is unchanged after you put it behind `mcp-graph`.

## Practical Implications

- `stdio` backends still run as local child processes
- remote MCPs still receive requests with whatever static headers were configured
- the generated policy can stop newly added backend tools from appearing until you refresh or reinstall
- if a backend could not be enumerated during install, `mcp-graph` can intentionally fall back to passthrough mode for that server to avoid breaking existing workflows
- the gateway still only reduces schema exposure and context growth; it does not change the security posture of the underlying tools

## Recommended Usage

- use the installer so only `mcp-graph` is visible to the client
- keep backend snapshots in user-owned config directories
- enable `MCP_GRAPH_AUDIT_LOG_PATH` when you want a JSONL trail of cache refreshes and proxied tool calls
- review backend MCP definitions before snapshotting them into production workflows
