"use strict";
// B00 app-route spike: shared diagnostics for the direct-script route and the MCP route.
// Throwaway code. Reports what the calling session can do; never prints secret values.

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCHEMA = "design-loom-spike/1";

function toolVersion(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, shell: false });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || result.stderr).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Whether `gh` has a stored credential for github.com. Read-only: `gh auth status` can refresh or
 * even remove a stored credential, so this asks `gh auth token` instead, which only reads it. The
 * output is checked for being non-empty and then dropped; the value is never kept or printed.
 * Whether the credential is still valid needs the network and is reported as unverified.
 */
function ghCredentialStored() {
  try {
    const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      timeout: 10_000,
      shell: false,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    if (result.error) return null;
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return null;
  }
}

function networkCheck() {
  if (process.env.SPIKE_SKIP_NETWORK === "1") return Promise.resolve("skipped");
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: "api.github.com",
        path: "/zen",
        method: "HEAD",
        timeout: 5000,
        headers: { "user-agent": "design-loom-spike" },
      },
      (response) => {
        response.resume();
        resolve(`reachable (HTTP ${response.statusCode})`);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve("blocked or slow (timeout)");
    });
    request.on("error", (error) => resolve(`error: ${error.code || error.message}`));
    request.end();
  });
}

function canWrite(directory) {
  const probe = path.join(directory, `.design-loom-spike-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "probe");
    fs.rmSync(probe, { force: true });
    return true;
  } catch (error) {
    return `no (${error.code || error.message})`;
  }
}

function requireAbsoluteRoot(root) {
  if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) {
    const error = new Error("root must be an absolute path to the design repository");
    error.exitCode = 2;
    throw error;
  }
  return path.resolve(root);
}

/** stat that reports an access error (for example a sandbox denial) instead of throwing. */
function statOrError(target) {
  try {
    return { stat: fs.statSync(target, { throwIfNoEntry: false }) };
  } catch (error) {
    return { error: error.code || error.message };
  }
}

async function diagnose({ root, route }) {
  const absoluteRoot = requireAbsoluteRoot(root);
  const { stat, error: statError } = statOrError(absoluteRoot);
  let hasGit;
  try {
    hasGit = fs.existsSync(path.join(absoluteRoot, ".git"));
  } catch (error) {
    hasGit = `error: ${error.code || error.message}`;
  }
  const envNames = Object.keys(process.env)
    .filter((name) => /^(COPILOT|GITHUB_COPILOT|VSCODE|CLAUDE|PLUGIN_)/.test(name))
    .sort();
  return {
    schema: SCHEMA,
    route,
    timestamp: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    plugin: {
      scriptDirectory: __dirname,
      pluginRoot: path.resolve(__dirname, ".."),
      env_PLUGIN_ROOT: process.env.PLUGIN_ROOT ?? null,
      env_PLUGIN_DATA: process.env.PLUGIN_DATA ?? null,
    },
    process: { cwd: process.cwd() },
    root: {
      path: absoluteRoot,
      exists: statError ? `unknown (${statError})` : Boolean(stat),
      isDirectory: Boolean(stat?.isDirectory()),
      hasGit,
    },
    tools: {
      git: toolVersion("git", ["--version"]),
      gh: toolVersion("gh", ["--version"]),
      ghCredentialStored: ghCredentialStored(),
      ghCredentialValidity: "unverified",
    },
    credentials: {
      GH_TOKEN_present: Boolean(process.env.GH_TOKEN),
      GITHUB_TOKEN_present: Boolean(process.env.GITHUB_TOKEN),
    },
    sandbox: {
      network_api_github_com: await networkCheck(),
      tempDirWritable: canWrite(os.tmpdir()),
      rootWritable: stat?.isDirectory()
        ? canWrite(absoluteRoot)
        : statError
          ? `unknown (${statError})`
          : "root missing",
    },
    environmentVariableNames: envNames,
  };
}

/** Writes one run report inside <root>/.design-loom/runs/ via a temp file and rename, then reads it back. */
function refuse(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function write({ root, route }) {
  const absoluteRoot = requireAbsoluteRoot(root);
  // Never create the checkout itself: a typo or stale worktree path must fail, not "succeed".
  if (!fs.statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw refuse(`root is not an existing folder: ${absoluteRoot}`);
  }
  const realRoot = fs.realpathSync(absoluteRoot);
  // Create .design-loom/runs one level at a time. Each level must be a real folder at exactly its
  // expected place: a symlink, even to another folder inside the checkout, could send the report
  // out of the ignored runs folder (into docs/, say) while still "succeeding".
  let realRuns = realRoot;
  for (const segment of [".design-loom", "runs"]) {
    const next = path.join(realRuns, segment);
    if (!fs.existsSync(next)) fs.mkdirSync(next);
    const stat = fs.lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(next) !== next) {
      throw refuse(`${path.relative(realRoot, next)} must be a real folder in the checkout, not a link`);
    }
    realRuns = next;
  }
  const name = `b00-spike-${route}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const target = path.join(realRuns, name);
  const temp = path.join(realRuns, `.${name}.tmp`);
  const body = `${JSON.stringify({ schema: SCHEMA, route, wroteAt: new Date().toISOString() }, null, 2)}\n`;
  fs.writeFileSync(temp, body, { flag: "wx" });
  fs.renameSync(temp, target);
  const readBack = fs.readFileSync(target, "utf8") === body;
  return {
    schema: SCHEMA,
    route,
    written: path.relative(realRoot, target).split(path.sep).join("/"),
    bytes: Buffer.byteLength(body),
    readBack,
    note: "Run reports live in .design-loom/runs/, which the design repo's .gitignore excludes.",
  };
}

module.exports = { diagnose, write, SCHEMA };
