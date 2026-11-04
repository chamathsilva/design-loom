#!/usr/bin/env node
"use strict";
// B00 spike, route A: a skill runs this script directly.
// Usage: node <plugin-root>/scripts/spike-cli.cjs <diagnose|write> --root <absolute-design-repo-root>

const { diagnose, write } = require("./spike-core.cjs");

async function main(argv) {
  const [command, ...rest] = argv;
  const rootIndex = rest.indexOf("--root");
  const root = rootIndex >= 0 ? rest[rootIndex + 1] : undefined;
  if (command === "diagnose") return diagnose({ root, route: "direct-script" });
  if (command === "write") return write({ root, route: "direct-script" });
  const error = new Error("usage: spike-cli.cjs <diagnose|write> --root <absolute path>");
  error.exitCode = 2;
  throw error;
}

main(process.argv.slice(2)).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  },
  (error) => {
    process.stdout.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    process.exitCode = error.exitCode ?? 5;
  },
);
