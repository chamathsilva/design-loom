// B00 spike plugin: both routes work locally before anyone tries them in the Copilot app.
// Throwaway with the spike branch.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const PLUGIN = join(ROOT, "spikes", "b00-app-route", "plugin");
const CLI = join(PLUGIN, "scripts", "spike-cli.cjs");
const MCP = join(PLUGIN, "scripts", "spike-mcp.cjs");
const ENV = { ...process.env, SPIKE_SKIP_NETWORK: "1" };

let designRoot: string;

before(async () => {
  designRoot = await mkdtemp(join(tmpdir(), "design-loom-spike-"));
});

after(async () => {
  await rm(designRoot, { recursive: true, force: true });
});

describe("plugin manifests", () => {
  const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

  test("plugin.json declares Agent Plugins 1.0 and a valid name", async () => {
    const manifest = await readJson(join(PLUGIN, "plugin.json"));
    assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${PLUGIN_ROOT} placeholder is what is tested
  test("mcp.json starts the bundled server through ${PLUGIN_ROOT}", async () => {
    const config = await readJson(join(PLUGIN, "mcp.json"));
    assert.equal(config.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    const server = config.mcpServers["design-loom-spike"];
    assert.equal(server.type, "stdio");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${PLUGIN_ROOT} placeholder is what is tested
    assert.deepEqual(server.args, ["${PLUGIN_ROOT}/scripts/spike-mcp.cjs"]);
  });

  test("the marketplace points at the plugin folder", async () => {
    const marketplace = await readJson(join(ROOT, ".github", "plugin", "marketplace.json"));
    assert.equal(marketplace.plugins[0].source, "./spikes/b00-app-route/plugin");
  });
});

describe("route A: direct script", () => {
  test("diagnose reports the runtime and the plugin root it ran from", async () => {
    const { stdout } = await run(process.execPath, [CLI, "diagnose", "--root", designRoot], { env: ENV });
    const report = JSON.parse(stdout);
    assert.equal(report.route, "direct-script");
    assert.equal(report.runtime.node, process.version);
    assert.equal(report.plugin.pluginRoot, resolve(PLUGIN));
    assert.equal(report.root.isDirectory, true);
    assert.equal(report.sandbox.network_api_github_com, "skipped");
  });

  test("write creates a report inside .design-loom/runs and reads it back", async () => {
    const { stdout } = await run(process.execPath, [CLI, "write", "--root", designRoot], { env: ENV });
    const report = JSON.parse(stdout);
    assert.equal(report.readBack, true);
    assert.match(report.written, /^\.design-loom\/runs\/b00-spike-direct-script-.+\.json$/);
    JSON.parse(await readFile(join(designRoot, ...report.written.split("/")), "utf8"));
  });

  test("a relative root is refused with exit code 2", async () => {
    await assert.rejects(
      run(process.execPath, [CLI, "diagnose", "--root", "relative/path"], { env: ENV }),
      (error: { code?: number }) => error.code === 2,
    );
  });

  test("never prints token values", async () => {
    const secret = "ghp_THIS_MUST_NOT_APPEAR_1234567890";
    const { stdout } = await run(process.execPath, [CLI, "diagnose", "--root", designRoot], {
      env: { ...ENV, GH_TOKEN: secret, GITHUB_TOKEN: secret },
    });
    assert.ok(!stdout.includes(secret));
    assert.equal(JSON.parse(stdout).credentials.GH_TOKEN_present, true);
  });
});

describe("route B: bundled MCP server", () => {
  test("completes the handshake, lists tools and runs both", async () => {
    const child = spawn(process.execPath, [MCP], { env: ENV, stdio: ["pipe", "pipe", "inherit"] });
    const responses = createInterface({ input: child.stdout });
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    responses.on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    });
    let nextId = 1;
    const call = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolveCall) => {
        const id = nextId++;
        pending.set(id, resolveCall);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    try {
      const init = (await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} })) as {
        result: { serverInfo: { name: string } };
      };
      assert.equal(init.result.serverInfo.name, "design-loom-spike");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const list = (await call("tools/list")) as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(
        list.result.tools.map((tool) => tool.name),
        ["spike_diagnose", "spike_write"],
      );

      const diagnose = (await call("tools/call", { name: "spike_diagnose", arguments: { root: designRoot } })) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(diagnose.result.isError, false);
      assert.equal(JSON.parse(diagnose.result.content[0]?.text ?? "{}").route, "mcp");

      const written = (await call("tools/call", { name: "spike_write", arguments: { root: designRoot } })) as {
        result: { content: Array<{ text: string }> };
      };
      assert.equal(JSON.parse(written.result.content[0]?.text ?? "{}").readBack, true);

      const relative = (await call("tools/call", { name: "spike_write", arguments: { root: "relative" } })) as {
        result: { isError: boolean };
      };
      assert.equal(relative.result.isError, true);

      const unknown = (await call("tools/call", { name: "nope", arguments: {} })) as { error: { code: number } };
      assert.equal(unknown.error.code, -32602);

      const missing = (await call("no/such/method")) as { error: { code: number } };
      assert.equal(missing.error.code, -32601);
    } finally {
      child.kill();
    }
  });
});
