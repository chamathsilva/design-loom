# B00 spike: can the Copilot app reach Design Loom's bundled code?

**Throwaway. Never merge this branch.** It answers one question for backlog B00 (design doc 02, "App-route spike gate"): when a contributor talks to the GitHub Copilot app, can a Design Loom skill run the bundled CLI without them opening a terminal or finding a file path?

Two candidate routes are tested side by side:

| Route | How it works | What would prove it |
|---|---|---|
| A: direct script | The skill tells the agent to run `node <plugin-root>/scripts/spike-cli.cjs` | The agent finds the plugin path by itself and the command runs |
| B: bundled MCP server | The plugin's `mcp.json` starts `node ${PLUGIN_ROOT}/scripts/spike-mcp.cjs` | The `spike_diagnose` and `spike_write` tools appear and return results |

Both report the same facts: Node version, the plugin path they ran from, whether `${PLUGIN_ROOT}` was set, git and gh availability, network access to api.github.com, sandbox write limits, and whether a small write inside `<root>/.design-loom/runs/` succeeds and reads back. They never print token values.

## How to run it (about 15 minutes)

You need the GitHub Copilot app and this repository checked out locally.

1. **Add the spike marketplace.** In the app, go to **Customize → Plugins → add a marketplace**, then try these in order until one works:
   - `chamathsilva/design-loom#spike/b00-app-route`
   - the GitHub URL of this repository with the branch `spike/b00-app-route`
   - the local folder of your checkout, with this branch checked out (`git checkout spike/b00-app-route`)

   Note which one worked. The marketplace is called **design-loom-spike**.
2. **Install and enable** the plugin **design-loom-spike**. Check that the skill **dl-spike-route** is listed and that an MCP server named **design-loom-spike** appears.
3. **Run the trials.** In each one, open a fresh session on the design-loom repository and type: *Run the Design Loom B00 spike.*

   | Trial | Session setup |
   |---|---|
   | T1 | Current checkout, sandbox off, tool permissions "Ask every time" |
   | T2 | New worktree |
   | T3 | Current checkout with the sandbox on (`/sandbox on`) |
   | T4 (optional) | Copilot CLI: `copilot plugin marketplace add <same source>`, install, then the same request |

4. **Record results** in [RESULTS.md](RESULTS.md): copy the agent's report for each trial and note every approval prompt you saw. Then send it to me, or commit it to this branch.

To remove the spike afterwards, uninstall **design-loom-spike** and remove its marketplace.

## Why this matters

If neither route works in the app, the everyday "no terminal needed" journey (DL-I02) has to be redesigned before B10 builds the real skills. If both work, B00 picks one using the evidence: path reliability, approval prompts and sandbox behaviour.

## Checked before handing over

- `plugin.json` and `mcp.json` validate against the official Agent Plugins 1.0 schemas.
- `tests/spike/b00-route.test.ts` runs both routes locally: the CLI commands, and a full MCP handshake with tool calls, including errors for a relative root and unknown tools.
- Not checked: anything inside the Copilot app. That's what the trials are for.
