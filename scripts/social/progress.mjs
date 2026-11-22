#!/usr/bin/env node
// Turns `claude -p --output-format stream-json --verbose` into progress lines for the
// terminal and the run log (run-task.sh pipes into this). Usage:
//   claude ... | node progress.mjs <raw.jsonl>
//
// Printed, each with the UTC time to the second:
// - the task's own progress lines, which the prompts ask for in the form
//   "PROGRESS <n>/<total> START|END <description>", as "task step n of total"
// - tool errors (a refused permission, a file that won't upload), first line only
// - the final report, in full
// - anything that isn't JSON (Claude Code's warnings on stderr), as is
// With BOCC_TRACE=1, also each browser tool call. The raw stream goes to <raw.jsonl>.
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";

const raw = process.argv[2] ? createWriteStream(process.argv[2], { flags: "a" }) : null;
const trace = process.env.BOCC_TRACE === "1";
const PROGRESS = /PROGRESS\s+(\d+)\s*\/\s*(\d+)\s+(START|END)\b[\s:–—-]*(.*)$/;

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const out = (line) => process.stdout.write(`${ts()}  ${line}\n`);
const short = (s, n = 160) => {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function toolText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join(" ");
  return "";
}

function describeCall(name, input = {}) {
  const tool = name.replace(/^mcp__chrome-devtools__/, "");
  const detail = input.url ?? input.filePath ?? input.text ?? input.value ?? input.uid ?? "";
  return detail === "" ? tool : `${tool} ${short(detail, 80)}`;
}

function onEvent(ev) {
  if (ev.type === "assistant") {
    for (const block of ev.message?.content ?? []) {
      if (block.type === "text") {
        for (const line of block.text.split("\n")) {
          const m = line.replace(/[`*]/g, "").match(PROGRESS);
          if (m) out(`task step ${m[1]} of ${m[2]}  ${m[3].padEnd(5)}  ${m[4].trim()}`);
        }
      } else if (block.type === "tool_use" && trace) {
        out(`  tool: ${describeCall(block.name, block.input)}`);
      }
    }
  } else if (ev.type === "user") {
    for (const block of ev.message?.content ?? []) {
      if (block.type === "tool_result" && block.is_error) {
        out(`  tool error: ${short(toolText(block.content))}`);
      }
    }
  } else if (ev.type === "result") {
    const secs = Math.round((ev.duration_ms ?? 0) / 1000);
    out(`task ${ev.is_error ? "ended with an error" : "finished"} after ${secs}s. Report:`);
    process.stdout.write(`${ev.result ?? "(no report)"}\n`);
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  raw?.write(`${line}\n`);
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    out(line);
    continue;
  }
  try {
    onEvent(ev);
  } catch (err) {
    out(`(progress: couldn't read an event: ${err.message})`);
  }
}
raw?.end();
