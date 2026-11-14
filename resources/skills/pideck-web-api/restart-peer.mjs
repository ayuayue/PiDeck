#!/usr/bin/env node
// 跨会话重启：由**另一个会话**执行，把目标会话的运行时停掉再启动，然后给目标发一条消息。
//
// 与 self-restart.mjs 的区别（技能里写成「推荐做法」的原因）：
//   self-restart.mjs 由被重启者自己发起，靠一个 detached 守卫接住；守卫自己挂了就无法自愈。
//   本脚本由别的会话发起，发起者本来就在另一个运行时里，不需要任何自愈机制。
//
// 用法（在协作会话里跑，参数是目标会话的 PiDeck sessionId）：
//   node restart-peer.mjs --target <sessionId> [--delay-ms 30000] [--message "..."]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LEDGER = path.join(os.homedir(), ".pi", "agent", "ledger");
const LOG = path.join(LEDGER, "restart-peer.log");
const STATE = path.join(LEDGER, "restart-peer.state.json");
const LIMIT = { stop: 60_000, start: 80_000, poll: 1_500 };

function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const row = stamp + "  " + line + "\n";
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, row);
  } catch {}
  process.stdout.write(row);
}

function state(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  const next = { ...cur, ...patch, at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(next, null, 2));
  } catch {}
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function settings() {
  const base = process.env.APPDATA || "";
  for (const dir of ["PiDeck", "PiDeck Dev"]) {
    try { return JSON.parse(fs.readFileSync(path.join(base, dir, "settings.json"), "utf8")); } catch {}
  }
  return {};
}

const cfg = settings();
const BASE = "http://127.0.0.1:" + (cfg.webServicePort || 8765);
const TOKEN = cfg.webServiceToken || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + pathname, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function runtimes() {
  const r = await api("/api/sessions/runtimes");
  return (r.json && r.json.runtimes) || [];
}

async function waitUntil(fn, limit, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    try { if (await fn()) return true; } catch {}
    await sleep(LIMIT.poll);
  }
  log("超时：" + label + "（" + limit + " 毫秒）");
  return false;
}

async function main() {
  const targetId = arg("--target", "");
  const delayMs = Number(arg("--delay-ms", "0")) || 0;
  const message = arg("--message", "跨会话重启完成。这条消息由协作会话在重启之后发出，用来验证目标会话能被唤醒。");
  if (!targetId) {
    console.error("用法：node restart-peer.mjs --target <sessionId> [--delay-ms 毫秒] [--message 文本]");
    process.exit(2);
  }
  const selfId = process.env.PIDECK_SESSION_ID || "";
  log("协作会话 " + selfId + " 开始重启目标 " + targetId + (delayMs ? "（延迟 " + delayMs + "ms）" : ""));

  if (delayMs) await sleep(delayMs);

  const before = (await runtimes()).find((x) => x.sessionId === targetId);
  if (!before) {
    log("失败：runtimes[] 里找不到目标，它本来就没在跑");
    state({ result: "no-target", targetId });
    process.exit(1);
  }
  log("重启前 generation=" + before.runtimeGeneration);

  const stop = await api("/api/sessions/" + targetId + "/runtime/stop", {
    method: "POST",
    body: JSON.stringify({ target: { sessionId: before.sessionId, agentId: before.agentId, runtimeGeneration: before.runtimeGeneration } }),
  });
  log("stop -> " + stop.status + " " + String(stop.text || "").slice(0, 160));

  const gone = await waitUntil(async () => !(await runtimes()).some((x) => x.sessionId === targetId), LIMIT.stop, "停止");
  if (!gone) {
    log("失败：没停稳。按技能 §5.6，此时不要再发 activate");
    state({ result: "stop-timeout", targetId, genBefore: before.runtimeGeneration });
    process.exit(1);
  }
  log("目标已停止");

  const act = await api("/api/sessions/" + targetId + "/runtime/activate", { method: "POST", body: JSON.stringify({}) });
  log("activate -> " + act.status + " " + String(act.text || "").slice(0, 160));

  let after = null;
  const up = await waitUntil(async () => {
    const hit = (await runtimes()).find((x) => x.sessionId === targetId);
    if (hit && hit.runtimeGeneration !== before.runtimeGeneration) { after = hit; return true; }
    return false;
  }, LIMIT.start, "启动");

  let health = 0;
  try { health = (await fetch(BASE + "/api/health")).status; } catch {}
  if (!up) {
    log("失败：启动没等到新进程，需要人工在 PiDeck 里点激活");
    state({ result: "start-failed", targetId, genBefore: before.runtimeGeneration, health });
    process.exit(1);
  }
  log("成功：generation " + before.runtimeGeneration + " -> " + after.runtimeGeneration + "，health=" + health);
  state({ result: health === 200 ? "ok" : "up-but-unhealthy", targetId, genBefore: before.runtimeGeneration, genAfter: after.runtimeGeneration, health });

  // 重启后由协作会话发一条消息，证明目标会话真的能被唤醒（这是人工重启里「他再发」那一步）。
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetId, messages: [{ role: "user", parts: [{ type: "text", text: message }] }] }),
      signal: ctl.signal,
    });
    log("唤醒消息 -> " + res.status + "（不等回复）");
    try { await res.body?.cancel(); } catch {}
    state({ messaged: res.status });
  } catch (e) {
    log("唤醒消息失败：" + (e && e.message));
    state({ messaged: "error" });
  } finally {
    clearTimeout(t);
  }
}

main().catch((e) => {
  log("异常：" + (e && e.message));
  process.exit(1);
});
