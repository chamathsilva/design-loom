#!/usr/bin/env node
"use strict";
// B00 spike, route B: a minimal stdio MCP server started from the plugin's mcp.json.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout. No dependencies. Logs go to stderr only.

const readline = require("node:readline");
const { diagnose, write } = require("./spike-core.cjs");

const ROOT_SCHEMA = {
  type: "object",
  properties: { root: { type: "string", description: "Absolute path of the design repository root" } },
  required: ["root"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "spike_diagnose",
    description:
      "Design Loom B00 spike: report what this session can do (runtime, plugin path, tools, network, sandbox).",
    inputSchema: ROOT_SCHEMA,
  },
  {
    name: "spike_write",
    description: "Design Loom B00 spike: write one small report inside <root>/.design-loom/runs/ and read it back.",
    inputSchema: ROOT_SCHEMA,
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;
  try {
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "design-loom-spike", version: "0.0.1" },
      };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const name = params?.name;
      const root = params?.arguments?.root;
      let output;
      if (name === "spike_diagnose") output = await diagnose({ root, route: "mcp" });
      else if (name === "spike_write") output = write({ root, route: "mcp" });
      else throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32602 });
      result = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], isError: false };
    } else if (method?.startsWith("notifications/")) {
      return;
    } else {
      if (!isNotification) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      return;
    }
    if (!isNotification) send({ id, result });
  } catch (error) {
    if (isNotification) return;
    if (method === "tools/call" && error.rpcCode === undefined) {
      send({
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true },
      });
    } else {
      send({ id, error: { code: error.rpcCode ?? -32603, message: error.message } });
    }
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  handle(request).catch((error) => process.stderr.write(`spike-mcp: ${error.stack}\n`));
});
