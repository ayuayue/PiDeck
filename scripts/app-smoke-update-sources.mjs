/**
 * 真实 app 端到端检测验证（临时）：对每个更新源（官方 + 3 镜像）启动打包的 win-unpacked app，
 * 检查「首次后台检查」是否成功完成 —— 成功信号：updateLastCheckAt 被写入 userData/settings.json。
 *
 * 依赖：release/win-unpacked/PiDeck.exe（已重打包，含 setFeedUrl feedOverride 保护修复）。
 * 用法：node scripts/app-smoke-update-sources.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = join("release", "win-unpacked", "PiDeck.exe");
const SETTINGS = join("settings.json");

const SOURCES = [
  { id: "official-github", feed: undefined }, // 无 env feed：走原生 GitHub provider（app-update.yml 缺失 → 由 PIDECK_E2E 兜底 github 配置）
  { id: "ghfast", feed: "https://ghfast.top/https://github.com/ayuayue/PiDeck/releases/latest/download" },
  { id: "ghproxy-net", feed: "https://ghproxy.net/https://github.com/ayuayue/PiDeck/releases/latest/download" },
  { id: "ghproxy-cxkpro", feed: "https://ghproxy.cxkpro.top/https://github.com/ayuayue/PiDeck/releases/latest/download" },
];

if (!existsSync(EXE)) {
  console.error(`缺少 ${EXE}，先执行 npm run pack`);
  process.exit(1);
}

/** 等待 settings.json 中出现 updateLastCheckAt，最长 waitMs。返回出现时间或 null。 */
function waitForCheck(userDataDir, waitMs) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const file = join(userDataDir, SETTINGS);
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        if (typeof s.updateLastCheckAt === "number" && s.updateLastCheckAt > 0) {
          return { at: new Date(s.updateLastCheckAt).toISOString(), foundAtMs: Date.now() - started };
        }
        if (s.appUpdateError || s.updateError) return { error: s.appUpdateError ?? s.updateError };
      } catch {
        // 写入中，重试
      }
    }
    spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 1500"], { stdio: "ignore" });
  }
  return null;
}

for (const source of SOURCES) {
  const userDataDir = join(tmpdir(), `pideck-smoke-${source.id}-${Date.now()}`);
  mkdirSync(userDataDir, { recursive: true });
  console.log(`\n===== ${source.id} =====`);
  console.log(`  feed: ${source.feed ?? "（无，原生 GitHub 官方链路）"}`);

  const env = {
    ...process.env,
    PIDECK_E2E: "1",
    PIDECK_E2E_USER_DATA_DIR: userDataDir,
  };
  if (source.feed) env.PIDEK_UPDATE_FEED_URL = source.feed;
  else delete env.PIDEK_UPDATE_FEED_URL;

  const child = spawn(EXE, [], { env, detached: true, stdio: "ignore" });
  child.unref();

  // 首查：start 延迟 10s + 抖动 ≤30s + 网络；等最多 75s
  const result = waitForCheck(userDataDir, 75_000);
  if (result) {
    console.log(`  ✅ 首查完成，updateLastCheckAt=${result.at}（启动后 ${(result.foundAtMs / 1000).toFixed(0)}s）`);
  } else {
    const file = join(userDataDir, SETTINGS);
    const raw = existsSync(file) ? readFileSync(file, "utf8").slice(0, 400) : "(无 settings.json)";
    console.log(`  ❌ 75s 内未见 updateLastCheckAt（可能是失败或抖动未触发）；settings 片段: ${raw}`);
  }

  // 杀进程（含子进程树）
  spawnSync("taskkill", ["/F", "/T", "/IM", "PiDeck.exe"], { stdio: "ignore" });
  // 隔离 userData 清理（保留日志供排查会占用磁盘；直接删干净）
  spawnSync("powershell", ["-NoProfile", "-Command", `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${userDataDir}'`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2000));
}

console.log("\n===== 真实 app 检测验证结束 =====");