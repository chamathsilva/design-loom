---
name: dl-spike-route
description: Use when asked to run the Design Loom B00 spike, or to check whether Design Loom's bundled tools can run in this app session.
---

# Design Loom B00 spike: app route check

This is a throwaway test. Your job is to find out, honestly, which ways of reaching this plugin's bundled code work in the current session, and to report exactly what happened. Do not pretend a step worked. A failure is a useful result.

## 1. Pick the root

Use the absolute path of the folder or repository this session is working in as `<root>`. State it.

## 2. Route A: run the bundled script directly

This file is `skills/dl-spike-route/SKILL.md` inside the plugin. The plugin root is two folders up from this file's folder, and the script is `<plugin-root>/scripts/spike-cli.cjs`.

1. Work out the absolute path of the plugin root **without asking the user**. Say exactly how you found it: given to you with this skill, read from your context, found by a search, or not obtainable.
2. If you have it, run these two commands with your terminal tool and keep their JSON output. Put each path in **single quotes**, so the shell takes it literally (double quotes still expand `$` and backticks). If a path itself contains a single quote, don't run the command; record that instead.
   - `node '<plugin-root>/scripts/spike-cli.cjs' diagnose --root '<root>'`
   - `node '<plugin-root>/scripts/spike-cli.cjs' write --root '<root>'`
3. If you can't determine the path or can't run commands, record that and continue.

## 3. Route B: call the bundled MCP tools

Check whether tools named `spike_diagnose` and `spike_write` from the `design-loom-spike` server are available to you. If they are, call each with `{ "root": "<root>" }` and keep the JSON output. If not, record that they aren't listed.

## 4. Git and GitHub tools

Without running anything that changes a repository, list which tools you have for Git and GitHub work (for example a terminal with `git`/`gh`, or GitHub tools that can create branches, commits or pull requests).

## 5. Report

Reply with:

1. A table with one row per route (A and B): worked yes/no, how the plugin path was obtained (route A), Node version, network to api.github.com, whether `gh` has a stored credential (`ghCredentialStored`), and whether the scoped write succeeded and read back. Report the credential and the network separately: a stored credential with the network blocked means "credential present, validity unverified", not "signed out". The scripts never check validity (`ghCredentialValidity` is always `unverified`).
2. The Git/GitHub tools you have.
3. The raw JSON outputs, in code blocks.
4. Finally, ask the user to note any approval prompts the app showed while you worked, and whether the session was a new worktree, the current checkout, or sandboxed.

Never print the value of a token or secret. The scripts only report whether credentials are present.
