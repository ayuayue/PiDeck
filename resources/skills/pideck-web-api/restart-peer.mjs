#!/usr/bin/env node
// 重启一个会话的运行时：由**另一个会话**执行，stop → activate → 给目标发一条消息。
// 「重启自己」和「重启别人」用的是同一个脚本：区别只在 --target 指向谁。
//
// 为什么必须由别的会话发起：stop 会杀掉发起请求的那个进程。被重启者自己发，就没有人接 activate。
//
// 为什么不用固定等待：目标可能正在生成回复，stop 会把它截断。等 90 秒既慢又靠猜。
// 这里改成订阅目标的事件流，看到本轮结束帧（finish / [DONE]）就立刻动手；
// 订阅 8 秒内没有任何 data: 帧，说明目标当前没有回合在跑，也立刻动手。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LEDGER = path.join(os.homedir(), ".pi", "agent", "ledger");
const LOG = path.join(LEDGER, "restart-peer.log");
const STATE = path.join(LEDGER, "restart-peer.state.json");
const LIMIT = { stop: 60_000, start: 80_000, poll: 1_500, waitTurnEnd: 120_000, quiet: 8_000 };

function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const row = stamp + "  " + line + "\n";
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, row);
  } catch {}
  process.stdout.write(row);
}

// reset=true 表示开一轮新记录：丢掉上一轮的字段，免得 no-target 的记录里带着上一次的
// genBefore/genAfter/messaged，读者会以为重启发生过。
function state(patch, reset = false) {
  let cur = {};
  if (!reset) { try { cur = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {} }
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

// settings.json 是端口与令牌的唯一真值；Dev 通道目录叫 PiDeck Dev。
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

// 等目标当前回合结束。返回 turn-end / quiet / idle / closed / cap / error。
// 判据是目标自己的事件流：finish 或 [DONE] 出现即本轮结束；6 秒无事件即视为没有活跃回合。
async function waitTurnEnd(targetId, capMs) {
  const started = Date.now();
  const ctl = new AbortController();
  const cap = setTimeout(() => ctl.abort(), capMs);
  try {
    const res = await fetch(BASE + "/api/sessions/" + targetId + "/stream", {
      headers: TOKEN ? { Authorization: "Bearer " + TOKEN } : {},
      signal: ctl.signal,
    });
    log("订阅目标事件流 -> " + res.status);
    if (!res.body) return "no-stream";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let frames = 0;
    // keepAlive 会定期发注释行（不是 data:），所以「静默」按最后一个 data: 帧算，不按最后一条字节。
    let lastEvent = Date.now();
    while (Date.now() - started < capMs) {
      const left = Math.max(200, LIMIT.quiet - (Date.now() - lastEvent));
      const step = await Promise.race([reader.read(), sleep(left).then(() => ({ timeout: true }))]);
      if (step.timeout) {
        if (Date.now() - lastEvent >= LIMIT.quiet) {
          // 2026-11-14 收到 review 意见：8 秒无 data: 帧不能证明回合结束。
          // 长工具调用（跑测试、下载）期间目标完全可能几十秒不吐帧；模型暂时无输出、
          // 网络抖动也一样。把这种情况判成「空闲」等于拿一个不成立的证据去 stop，
          // 会把目标正在跑的回合截断。改为 unknowns，调用方默认放弃。
          log("目标 " + Math.round(LIMIT.quiet / 1000) + " 秒没有新的 data: 帧。这不能证明回合结束" +
            "（长工具调用、模型暂无输出、连接异常都会这样），判为状态未知");
          return "unknown";
        }
        continue;
      }
      if (step.done) {
        log("目标事件流结束，动手");
        return "closed";
      }
      buf += dec.decode(step.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        frames++;
        lastEvent = Date.now();
        if (line.includes("\"finish\"") || line.includes("[DONE]")) {
          log("收到本轮结束帧（第 " + frames + " 帧），动手");
          return "turn-end";
        }
      }
    }
    log("等待上限 " + capMs + " 毫秒用尽，目标仍在流式输出；这次不动手");
    return "cap";
  } catch (e) {
    if (e && e.name === "AbortError") return "cap";
    log("订阅出错：" + (e && e.message));
    return "error";
  } finally {
    clearTimeout(cap);
    try { ctl.abort(); } catch {}
  }
}

async function main() {
  const targetId = arg("--target", "");
  const waitCap = Number(arg("--wait-turn-end", String(LIMIT.waitTurnEnd))) || LIMIT.waitTurnEnd;
  const noWait = process.argv.includes("--no-wait");
  const message = arg("--message", "重启完成。这条消息由协作会话在重启之后发出，用来验证目标能被唤醒。");
  if (!targetId) {
    console.error("用法：node restart-peer.mjs --target <sessionId> [--wait-turn-end 毫秒] [--no-wait] [--wait-only] [--message 文本]");
    process.exit(2);
  }
  const selfId = process.env.PIDECK_SESSION_ID || "";
  const t0 = Date.now();
  log("协作会话 " + selfId + " 开始重启目标 " + targetId);

  const before = (await runtimes()).find((x) => x.sessionId === targetId);
  if (!before) {
    log("失败：runtimes[] 里找不到目标，它本来就没在跑");
    state({ result: "no-target", targetId }, true);
    process.exit(1);
  }
  log("重启前 generation=" + before.runtimeGeneration);
  state({ result: "dispatched", targetId, genBefore: before.runtimeGeneration }, true);

  // 调试用：只判定目标当前有没有回合在跑，不动手（不会被误用成重启）。
  if (process.argv.includes("--wait-only")) {
    const waited = await waitTurnEnd(targetId, waitCap);
    log("--wait-only：判定 " + waited + "，耗时 " + Math.round((Date.now() - t0) / 1000) + " 秒；没有动任何东西");
    state({ result: "wait-only", waited, targetId });
    return;
  }
  if (!noWait) {
    const waited = await waitTurnEnd(targetId, waitCap);
    state({ waited, waitMs: Date.now() - t0 });
    // unknown 一起放弃。之前的写法只挡 cap/error，于是 8 秒静默会走到 stop——
    // 那正是 review 指出的「不足以证明可以安全停止」被当成了可以。
    if (waited === "cap" || waited === "error" || waited === "unknown") {
      log("放弃：目标可能还在生成（判定 " + waited + "）。确认它已经不动之后再跑，或加 --no-wait 自己承担截断风险");
      state({ result: "wait-failed", waited, targetId });
      process.exit(1);
    }
  }

  const stop = await api("/api/sessions/" + targetId + "/runtime/stop", {
    method: "POST",
    body: JSON.stringify({ target: { sessionId: before.sessionId, agentId: before.agentId, runtimeGeneration: before.runtimeGeneration } }),
  });
  log("stop -> " + stop.status + " " + String(stop.text || "").slice(0, 160));
  // 2026-11-14 review 意见：原来不看 stop 的返回码就往下轮询、启动。
  // 鉴权失败（401）、参数过期（409，target 的 runtimeGeneration 已被别的动作改过）
  // 都会走到这里，此时继续 activate 只会把状态搞得更乱。
  if (stop.status < 200 || stop.status >= 300) {
    log("失败：stop 返回 " + stop.status + "，不再继续。目标可能仍在运行，检查令牌与 target 是否过期");
    state({ result: "stop-failed", status: stop.status, targetId });
    process.exit(1);
  }

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
  const totalMs = Date.now() - t0;
  log("成功：generation " + before.runtimeGeneration + " -> " + after.runtimeGeneration + "，health=" + health + "，总耗时 " + Math.round(totalMs / 1000) + " 秒");
  state({ result: health === 200 ? "ok" : "up-but-unhealthy", targetId, genBefore: before.runtimeGeneration, genAfter: after.runtimeGeneration, health, totalMs });

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
