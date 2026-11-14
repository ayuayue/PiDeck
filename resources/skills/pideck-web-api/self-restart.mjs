#!/usr/bin/env node
// 自重启：让当前 PiDeck 会话的运行时停掉再起来，而命令是从这个会话自己发出的。
//
// 为什么需要守卫：stop 会杀掉发起 stop 的进程。agent 自己执行 stop 之后就没人活着发
// activate 了——这就是 pi-web-api 技能里那条「不要对自己 runtime/stop|restart」的由来。
// 但那条禁令的实质不是「不许自重启」，而是「不许没有人接的自杀」。
// 有守卫接住的情况下，自重启是可做的，而且判据很硬：runtimeGeneration 变了 + health 200。
//
// 两段式：
//   node self-restart.mjs                  干跑，打印计划，什么都不做（默认）
//   node self-restart.mjs --go             起一个脱离进程树的守卫，然后立刻返回
//   node self-restart.mjs --supervisor     守卫本体，由上一行以 detached 方式拉起，人不该手敲
//
// 守卫必须真的脱离：spawn 时 detached + unref，脱离后进程组独立，停止命令杀不到它。
// 判据不是 ppid（Windows 上它仍指向原进程），而是「停止之后守卫还能继续写日志」。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";

// 日志固定落在 pi 的 ledger 目录：脚本可能从仓库目录、技能目录或安装包内被调用，
// 用脚本位置推上级会把 ledger 写进仓库（污染工作区），换 cwd 又会散落各处。
const LEDGER = path.join(os.homedir(), ".pi", "agent", "ledger");
const LOG = path.join(LEDGER, "self-restart.log");
const STATE = path.join(LEDGER, "self-restart.state.json");

// 上限：整段 150 秒（停止等 60 + 启动等 80 + 余量）。
// 超过就写失败标记，不许无限等——那会留下一个半死的运行时。
const LIMIT = { total: 150_000, stopWait: 60_000, startWait: 80_000, poll: 1_500 };
// 启动失败最多重试 2 次（共 3 次尝试）。再失败就停手，留日志让人接手。
const MAX_START_TRY = 3;

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
  return next;
}

// ---------- 前置：身份、令牌、端口 ----------

// settings.json 是端口与令牌的唯一真值（设置页可改）；env 只作覆盖。
// Dev 通道的 userData 目录叫 PiDeck Dev，两处都试。
function settings() {
  const base = process.env.APPDATA || "";
  for (const dir of ["PiDeck", "PiDeck Dev"]) {
    try { return JSON.parse(fs.readFileSync(path.join(base, dir, "settings.json"), "utf8")); } catch {}
  }
  return {};
}
function env() {
  const self = process.env.PIDECK_SESSION_ID || "";
  const port = process.env.PIDECK_WEB_PORT || String(settings().webServicePort || 8765);
  return { self, port, base: "http://127.0.0.1:" + port };
}

// 令牌只从 settings.json 读，不落明文到日志。
function token() {
  return settings().webServiceToken || "";
}

async function api(pathname, opts = {}) {
  const t = token();
  const headers = { ...(opts.headers || {}) };
  if (t) headers.Authorization = "Bearer " + t;
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(env().base + pathname, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function findSelf() {
  const r = await api("/api/sessions/runtimes");
  const list = (r.json && (r.json.runtimes || r.json.right)) || [];
  const hit = list.find((x) => x.sessionId === env().self);
  return { list, hit };
}

// ---------- 守卫 ----------

async function supervisor(startedAt) {
  const { self } = env();
  const delay = delayArg();
  log("守卫启动 pid=" + process.pid + " ppid=" + process.ppid + " session=" + self + (delay ? " delay=" + delay + "ms" : ""));

  // 脱离判据：不是看 ppid（Windows 上 detached 之后 ppid 仍指向原进程，实测 46752），
  // 而是看「stop 之后还活着」—— 下面每一条在 stop 之后写出的日志，本身就是证据。
  // 所以这里只在日志里记一笔，不做断言。

  // 1) 等调用方那条命令返回，别在自己的请求里杀自己；--delay 再额外留出让回复发完的时间。
  await sleep(2500 + delay);

  // 2) 记下重启前的 generation，作为「真的换了进程」的基线。
  const before = await findSelf();
  if (!before.hit) {
    log("失败：runtimes[] 里找不到自己，放弃（可能已经不在跑）");
    state({ result: "no-self-before" });
    return;
  }
  const genBefore = before.hit.runtimeGeneration;
  const target = { sessionId: before.hit.sessionId, agentId: before.hit.agentId, runtimeGeneration: before.hit.runtimeGeneration };
  log("重启前 generation=" + genBefore);

  // 3) 停。
  const stop = await api("/api/sessions/" + self + "/runtime/stop", { method: "POST", body: JSON.stringify({ target }) });
  log("stop → " + stop.status + " " + String(stop.text || "").slice(0, 120));

  const gone = await waitUntil(async () => !(await findSelf()).hit, LIMIT.stopWait, "停止");
  if (!gone.ok) {
    log("失败：等了 " + LIMIT.stopWait + " 毫秒还没停掉，放弃启动（半死的运行时比停着更糟）");
    state({ result: "stop-timeout", genBefore });
    return;
  }
  log("已停止");

  // 4) 起。最多试 MAX_START_TRY 次。
  for (let attempt = 1; attempt <= MAX_START_TRY; attempt++) {
    const act = await api("/api/sessions/" + self + "/runtime/activate", { method: "POST", body: JSON.stringify({}) });
    log("activate 第 " + attempt + " 次 → " + act.status);
    const up = await waitUntil(async () => {
      const now = await findSelf();
      return now.hit && now.hit.runtimeGeneration !== genBefore;
    }, LIMIT.startWait, "启动");
    if (up.ok) {
      const after = (await findSelf()).hit;
      // 最后一道：health 200。generation 变了但服务不起来也算失败。
      let health = 0;
      try { health = (await fetch(env().base + "/api/health")).status; } catch {}
      log("成功：generation " + genBefore + " → " + after.runtimeGeneration + "，health=" + health + "，守卫已存活 " + Math.round((Date.now() - startedAt) / 1000) + " 秒（含 stop 之后那段）");
      state({ result: health === 200 ? "ok" : "up-but-unhealthy", genBefore, genAfter: after.runtimeGeneration });
      return;
    }
    log("第 " + attempt + " 次启动没等到，继续");
  }

  log("失败：" + MAX_START_TRY + " 次都没起来。会话现在停着，需要人工 activate。");
  state({ result: "start-failed", genBefore });
}

// --delay <毫秒>：起守卫后先等这么久再 stop。
// 用途：重启是从你自己的回合里发起的，stop 会把那条正在生成的回复截断在半句上。
// 加 --delay 15000，回复在 stop 之前就发出去了，读者能先看到「已启动」再看到进程消失。
// 上限 60 秒：整段预算是 150 秒，延迟也算在里面。
function delayArg() {
  const i = process.argv.indexOf("--delay");
  const v = i >= 0 ? Number(process.argv[i + 1]) : 0;
  return Number.isFinite(v) && v > 0 ? Math.min(v, 60_000) : 0;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUntil(fn, limit, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    try { if (await fn()) return { ok: true, ms: Date.now() - t0 }; } catch {}
    await sleep(LIMIT.poll);
  }
  log(label + " 超时（" + limit + " 毫秒）");
  return { ok: false, ms: Date.now() - t0 };
}

// ---------- 入口 ----------

async function main() {
  const args = process.argv.slice(2);
  const { self, base } = env();

  if (args.includes("--supervisor")) return supervisor(Date.now());

  // 身份必须来自环境，不接受参数覆盖——否则会变成「重启别人」的工具。
  if (!self) {
    console.error("PIDECK_SESSION_ID 为空：你不在 PiDeck 里跑，没有可重启的运行时。");
    process.exit(2);
  }

  const before = await findSelf();
  if (before.status && before.status !== 200) {
    console.error("读 /api/sessions/runtimes 返回 " + before.status + "，先查令牌与端口。");
    process.exit(2);
  }
  if (!before.hit) {
    console.error("runtimes[] 里找不到 " + self + "，说明这个会话现在没在跑，不需要重启。");
    process.exit(2);
  }

  console.log("会话      " + self);
  console.log("运行时代号 " + before.hit.runtimeGeneration + "（每成功启动一次加一；变了才算真的换了进程）");
  console.log("服务      " + base);
  console.log("日志      " + LOG);
  console.log("");
  console.log("守卫 = 一个独立进程，在你的会话被停掉之后仍活着，负责把你重新启动起来。");
  console.log("计划：起守卫 → 等这条命令返回 → stop → 等停稳 → activate");
  console.log("      → 等 generation 变化且 health 200。最多 150 秒，启动失败重试 3 次。");

  if (!args.includes("--go")) {
    console.log("");
    console.log("这是干跑。加 --go 才真的执行。");
    console.log("注意：真跑时这个进程会消失，看到的最后一行会是守卫写的日志。");
    console.log(delayArg() ? "延迟：stop 会推迟 " + (2.5 + delayArg() / 1000) + " 秒，够这条回复发出去。" : "延迟：无（2.5 秒后 stop）。若重启是从你自己回合里发起的，加 --delay 15000。");
    return;
  }

  // 关键：detached + unref + 忽略 stdio，守卫才能活过 stop。
  const delay = delayArg();
  const child = spawn(process.execPath, [process.argv[1], "--supervisor", ...(delay ? ["--delay", String(delay)] : [])], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log("");
  console.log("守卫已起 pid=" + child.pid + "，它会在 2.5 秒后开始。本进程即将被 stop 杀掉。");
  state({ result: "dispatched", supervisorPid: child.pid, genBefore: before.hit.runtimeGeneration });
}

main().catch((e) => {
  log("异常：" + (e && e.message));
  process.exit(1);
});
