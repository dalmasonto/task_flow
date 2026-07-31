# Layered Config Discovery for TaskFlow Settings

**Date:** 2026-04-06
**Task:** #348
**Status:** Approved

## Overview

Add a global config file (`~/.taskflow_config.json`) that the MCP server reads at startup. Server-level settings (port, host, database path, etc.) live in this file instead of being hardcoded. The `update_setting` tool can write server settings back to the config file (changes take effect on next restart).

## Config File

**Location:** `~/.taskflow_config.json`

**Shape:**
```json
{
  "port": 3456,
  "host": "127.0.0.1",
  "databasePath": "~/.taskflow/taskflow.db",
  "logLevel": "info",
  "agentLivenessInterval": 30000,
  "maxPortAttempts": 10
}
```

All fields are optional. Missing fields use defaults.

## Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `3456` | SSE server port |
| `host` | `"127.0.0.1"` | SSE server bind address |
| `databasePath` | `"~/.taskflow/taskflow.db"` | SQLite database path |
| `logLevel` | `"info"` | Log verbosity: debug, info, warn, error |
| `agentLivenessInterval` | `30000` | Agent liveness check interval (ms) |
| `maxPortAttempts` | `10` | Max port fallback attempts |

## Behavior

### Startup
1. Resolve `~/.taskflow_config.json` (expand `~` to home directory)
2. If file exists: read, parse JSON, merge with defaults (file values override defaults)
3. If file missing: use all defaults silently
4. If file malformed: log warning to stderr, use all defaults
5. Export frozen singleton config object

### Setting Routing
- **Server settings** (`port`, `host`, `databasePath`, `logLevel`, `agentLivenessInterval`, `maxPortAttempts`): stored in config file
- **UI settings** (everything else — `timerBarDisplayMode`, `statusColors`, etc.): stored in SQLite `settings` table

### get_setting
- If key is a server setting: return value from loaded config
- Otherwise: return from SQLite (existing behavior)

### update_setting
- If key is a server setting: read config file, update the key, write back, return message noting restart required
- Otherwise: write to SQLite (existing behavior)

### CLI / Env Override Priority
Config file values can still be overridden by CLI args and env vars at runtime:
1. Hardcoded defaults (lowest)
2. `~/.taskflow_config.json`
3. `TASKFLOW_*` environment variables
4. `--port`, `--host` CLI arguments (highest)

## Files

| Action | File | Changes |
|--------|------|---------|
| Create | `mcp-server/src/config.ts` | Config loader, defaults, read/write-back, singleton export |
| Modify | `mcp-server/src/sse.ts` | Import config for port, host, maxPortAttempts |
| Modify | `mcp-server/src/db.ts` | Import config for databasePath |
| Modify | `mcp-server/src/index.ts` | Init config at startup, use agentLivenessInterval from config |
| Modify | `mcp-server/src/tools/settings.ts` | Route server settings to config file, UI settings to SQLite |

## Acceptance Criteria

- [ ] MCP server reads `~/.taskflow_config.json` on startup
- [ ] All 6 settings are configurable via this file
- [ ] Falls back to defaults if file doesn't exist
- [ ] Logs warning if file is malformed JSON
- [ ] CLI args and env vars override config file values
- [ ] `get_setting` returns server settings from config
- [ ] `update_setting` writes server settings back to config file with restart notice
- [ ] Existing UI settings continue working via SQLite unchanged

## Future Layers (Not in Scope)

- Project-level config: `.taskflow/settings.json`
- Local override: `.taskflow/settings.local.json`
- Runtime config via MCP tool calls
