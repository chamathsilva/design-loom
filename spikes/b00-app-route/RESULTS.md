# B00 spike results (compatibility record)

Reports are pasted as the agent produced them, except that the home folder name is replaced with `~`.

## Environment

| Item | Value |
|---|---|
| Date | 2026-11-04 (local time; reports are timestamped 2026-11-05 UTC) |
| Copilot app version (Help → About) | not recorded |
| macOS version | not recorded (darwin, arm64) |
| Marketplace source that worked | `chamathsilva/design-loom#spike/b00-app-route` (added from the Customize → Plugins → Manage marketplaces dialog; the catalog loaded and the plugin was installable) |
| Plugin listed and enabled? | Yes, version 0.0.1 |
| Skill `dl-spike-route` visible? | Yes |
| MCP server `design-loom-spike` visible? | Yes, with a green check under Installed → MCP Servers |
| How the session started | The app clones the repo itself. Sessions run in an app chat folder (`~/.copilot/chats/<date>/<name>`), which is not a git repository. There was no way to open a local folder as the project. |

## T1: sandbox off, no mode changes, the app's own chat folder

Not a worktree and not the user's local clone. The sandbox was not turned on. The tool-permission setting was left as the app had it, so the "Ask every time" condition was not verified.

- Approval prompts shown: none, in every run below.
- Route A worked? **No, the first time.** The agent found the plugin path from the skill and ran the script, but `node` was not on the app's PATH: `/bin/bash: node: command not found`. The app's own terminal said the same (`zsh: command not found: node`). Node here comes from nvm, which GUI apps don't load. `git` and `gh` were found.
- Route B worked? **No, the first time.** `spike_diagnose` and `spike_write` were not listed. The server is started with `node`, so it most likely could not start for the same reason.

### T1b: Node made reachable (symlink to `~/.local/bin/node`, a folder already on the app's PATH)

Same conversation as T1, so the MCP server was not restarted.

- Route A: **worked.** Diagnose ran, and the scoped write was read back.
- Route B: **no.** The tools were still not listed (stale session).

### T1c: fresh conversation after restarting the MCP server, Node reachable

- Route A: **worked.** The plugin path was derived two folders up from the skill path given in context.
- Route B: **worked.** `spike_diagnose` and `spike_write` were called, and the scoped write was read back. The agent listed 25 tools on 2 servers (`design-loom-spike` and the app's built-in `github-mcp-server`).

Observations that matter for the design:

1. **Node must be on the app's PATH.** Both routes need it. A user whose Node comes from nvm, asdf or similar will fail unless it is linked into a folder on the app's PATH.
2. **The MCP server only appears in sessions that start after it can start.** A session begun before Node was reachable never listed the tools, even after Node was fixed.
3. **`PLUGIN_ROOT` and `PLUGIN_DATA` are set for the MCP server, not for shell commands.** The MCP server also got `CLAUDE_PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and their `*_DATA` equivalents. The direct script saw none of them (`env_PLUGIN_ROOT: null`), so Route A depends on the agent finding the plugin folder from the skill's own path.
4. **The session's working folder is not a git repository** (`hasGit: false`). The MCP server's own working directory is the plugin folder, so a tool needs an explicit `--root`/`root` argument pointing at the design repository. Something has to supply that path.
5. **No approval prompts** appeared for running scripts or calling MCP tools. Not tested with the sandbox on.
6. `api.github.com` was reachable (HTTP 200). A `gh` credential was stored. `GH_TOKEN` was present in the environment of both routes' processes. Validity was not checked and no token value was printed.
7. The MCP server was shown as "Design Loom Spike · Spike Diagnose" in the app's tool-call list. The agent's early search for the literal name `spike_diagnose` did not find it, so skill text should say how to find the tools.

Agent report, T1c (Route B diagnose, then Route A diagnose, then both scoped writes):

```json
{
  "schema": "design-loom-spike/1",
  "route": "mcp",
  "timestamp": "2026-11-05T01:33:03.980Z",
  "runtime": { "node": "v24.22.2", "platform": "darwin", "arch": "arm64" },
  "plugin": {
    "scriptDirectory": "~/.copilot/installed-plugins/design-loom-spike/design-loom-spike/scripts",
    "pluginRoot": "~/.copilot/installed-plugins/design-loom-spike/design-loom-spike",
    "env_PLUGIN_ROOT": "~/.copilot/installed-plugins/design-loom-spike/design-loom-spike",
    "env_PLUGIN_DATA": "~/.copilot/plugin-data/design-loom-spike/design-loom-spike"
  },
  "process": { "cwd": "~/.copilot/installed-plugins/design-loom-spike/design-loom-spike" },
  "root": {
    "path": "~/.copilot/chats/2026-11-04/vigilant-broccoli-b7713d60",
    "exists": true,
    "isDirectory": true,
    "hasGit": false
  },
  "tools": {
    "git": "git version 2.56.0",
    "gh": "gh version 2.102.1 (2026-10-20)",
    "ghCredentialStored": true,
    "ghCredentialValidity": "unverified"
  },
  "credentials": { "GH_TOKEN_present": true, "GITHUB_TOKEN_present": false },
  "sandbox": { "network_api_github_com": "reachable (HTTP 200)", "tempDirWritable": true, "rootWritable": true },
  "environmentVariableNames": [
    "CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "COPILOT_AGENT_SESSION_ID",
    "COPILOT_CLI_ENABLED_FEATURE_FLAGS", "COPILOT_ENABLE_BUILTIN_GITHUB_MCP",
    "COPILOT_GH_ACCOUNT_github_2E_com_<account>", "COPILOT_MCP_CIMD_CLIENT_ID_URL",
    "COPILOT_PLUGIN_DATA", "COPILOT_PLUGIN_ROOT", "COPILOT_RUNTIME_PROCESS_FILE_LOGGING",
    "COPILOT_SWE_AGENT_BACKGROUND_AGENTS", "COPILOT_SWE_AGENT_UNIFIED_TASK_TOOL",
    "COPILOT_TRAMPOLINE_IDENTIFIER", "COPILOT_TRAMPOLINE_PORT", "COPILOT_TRAMPOLINE_TOKEN",
    "PLUGIN_DATA", "PLUGIN_ROOT"
  ]
}
```

```json
{
  "schema": "design-loom-spike/1",
  "route": "direct-script",
  "timestamp": "2026-11-05T01:33:04.021Z",
  "runtime": { "node": "v24.22.2", "platform": "darwin", "arch": "arm64" },
  "plugin": {
    "scriptDirectory": "~/.copilot/installed-plugins/design-loom-spike/design-loom-spike/scripts",
    "pluginRoot": "~/.copilot/installed-plugins/design-loom-spike/design-loom-spike",
    "env_PLUGIN_ROOT": null,
    "env_PLUGIN_DATA": null
  },
  "process": { "cwd": "~/.copilot/chats/2026-11-04/vigilant-broccoli-b7713d60" },
  "root": {
    "path": "~/.copilot/chats/2026-11-04/vigilant-broccoli-b7713d60",
    "exists": true,
    "isDirectory": true,
    "hasGit": false
  },
  "tools": {
    "git": "git version 2.56.0",
    "gh": "gh version 2.102.1 (2026-10-20)",
    "ghCredentialStored": true,
    "ghCredentialValidity": "unverified"
  },
  "credentials": { "GH_TOKEN_present": true, "GITHUB_TOKEN_present": false },
  "sandbox": { "network_api_github_com": "reachable (HTTP 200)", "tempDirWritable": true, "rootWritable": true },
  "environmentVariableNames": [
    "COPILOT_AGENT_SESSION_ID", "COPILOT_CLI", "COPILOT_CLI_ENABLED_FEATURE_FLAGS",
    "COPILOT_ENABLE_BUILTIN_GITHUB_MCP", "COPILOT_GH_ACCOUNT_github_2E_com_<account>",
    "COPILOT_MCP_CIMD_CLIENT_ID_URL", "COPILOT_RUNTIME_PROCESS_FILE_LOGGING",
    "COPILOT_SWE_AGENT_BACKGROUND_AGENTS", "COPILOT_SWE_AGENT_UNIFIED_TASK_TOOL",
    "COPILOT_TRAMPOLINE_IDENTIFIER", "COPILOT_TRAMPOLINE_PORT", "COPILOT_TRAMPOLINE_TOKEN"
  ]
}
```

```json
{
  "schema": "design-loom-spike/1",
  "route": "mcp",
  "written": ".design-loom/runs/b00-spike-mcp-2026-11-05T01-33-04-103Z.json",
  "bytes": 97,
  "readBack": true
}
```

```json
{
  "schema": "design-loom-spike/1",
  "route": "direct-script",
  "written": ".design-loom/runs/b00-spike-direct-script-2026-11-05T01-33-04-299Z.json",
  "bytes": 107,
  "readBack": true
}
```

## T2: new worktree

Not run.

## T3: sandbox on

Not run. Network, file-write and approval behaviour with the sandbox on are therefore unknown.

## T4 (optional): Copilot CLI

Not run.

## Conclusion (draft, for review; the route choice is the maintainer's)

- Selected route: **not decided.** Both routes work in the Copilot app once Node is on the app's PATH.
- Reasons to lean toward the MCP route (Route B):
  - It gets `PLUGIN_ROOT` and `PLUGIN_DATA` from the app, so no path-finding is needed.
  - It returns structured results, and there were no approval prompts.
- Reasons to lean toward the direct script (Route A):
  - It works the same way in any agent that can run a command.
  - It doesn't depend on an MCP server starting.
  - Its weakness is that it needs the agent to derive the plugin folder from the skill's own path.
- Required contributor prerequisites (Node, sign-in, permissions):
  - **Node 24 on the app's PATH.** This is the biggest finding. nvm-installed Node is not visible to the app, so the user needed a symlink. A setup check, an install note, or a bundled runtime is needed.
  - The GitHub sign-in in the app (a credential was present).
  - No approval prompts were seen with default permissions and the sandbox off.
- Open problems:
  - The design repository path has to be passed in. The session's folder is an app chat folder and not a git repository. How will the skill find the contributor's checkout? The app only lets a project be created from a GitHub repository list.
  - The MCP server starts per session, so changing Node or the plugin needs a new session. The skill should tell the user this.
  - T2, T3 and T4 are not run.
  - The app version and macOS version were not recorded.
