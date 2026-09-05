/**
 * 镜像实测脚本（临时）：验证三个预设镜像的「访问 / 检测 / 下载」链路。
 *
 * 模拟 electron-updater GenericProvider 的真实请求序列：
 *   1. GET <base>/latest.yml（feed 检测）→ 校验 version/path/sha512 字段
 *   2. 与首个成功源内容对比（三个镜像应返回同一份官方 latest.yml）
 *   3. GET <base>/<setup.exe> Range 首段 → 期望 206
 *   4. GET <base>/<setup.exe> Range 中段（非首字节分片）→ 期望 206
 *
 * 完整下载 + sha512 校验单独跑（138MB/源，按需选最快源执行 --full）。
 * 用法：node scripts/probe-update-mirrors.mjs [--full] [--only ghfast]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SETUP = "PiDeck-0.7.3-setup.exe";
const MIRRORS = [
  { id: "ghfast", base: "https://ghfast.top/https://github.com/ayuayue/PiDeck/releases/latest/download" },
  { id: "ghproxy-net", base: "https://ghproxy.net/https://github.com/ayuayue/PiDeck/releases/latest/download" },
  { id: "ghproxy-cxkpro", base: "https://ghproxy.cxkpro.top/https://github.com/ayuayue/PiDeck/releases/latest/download" },
];

const onlyIdx = MIRRORS.findIndex((m) => m.id === process.argv.find((a) => a.startsWith("--only="))?.slice(7));
const only = onlyIdx >= 0 ? [MIRRORS[onlyIdx]] : MIRRORS;
const FULL = process.argv.includes("--full");

/** 二进制请求；range 用 curl 内置 -r（跟随 302 后自动重发 Range，模拟 electron-updater 跟随重定向）。 */
function fetchBin(url, { range, outFile, timeoutSec = 180 } = {}) {
  const args = [
    "-sL", // 跟随重定向：GitHub releases/latest 会 302 到具体版本 + 签名对象存储
    "--noproxy", "*", "-x", "", "--max-time", String(timeoutSec),
    "-w", "%{http_code}|%{size_download}|%{time_total}|%{speed_download}",
  ];
  if (range) args.push("-r", range);
  if (outFile) args.push("-o", outFile);
  args.push(url);
  const res = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 1 << 20 });
  if (res.error) return { error: res.error.message };
  const [code, size, timeTotal, speed] = (res.stdout || "").split("|");
  return { code: Number(code), size: Number(size), timeSec: Math.round(Number(timeTotal) * 100) / 100, speedKBps: Math.round(Number(speed) / 1024) };
}

/** 文本请求（latest.yml）：body 落盘，-w 结果单独回收，避免混在 stdout。 */
function fetchText(url, outFile = "/tmp/probe-text.bin") {
  const res = spawnSync(
    "curl",
    ["-sL", "--noproxy", "*", "-x", "", "--max-time", "30", "-o", outFile, "-w", "%{http_code}|%{time_total}", url],
    { encoding: "utf8", maxBuffer: 1 << 20 },
  );
  if (res.error) return { error: res.error.message };
  const [code, timeTotal] = (res.stdout || "").split("|");
  const body = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  return { code: Number(code), timeSec: Math.round(Number(timeTotal) * 100) / 100, body };
}

function parseYml(text) {
  const version = /^version:\s*"?([^"\s#]+)"?/m.exec(text)?.[1] ?? "?";
  const path = /^path:\s*(\S+)/m.exec(text)?.[1] ?? "?";
  const sha512 = /^sha512:\s*(\S+)/m.exec(text)?.[1] ?? "";
  const files = /^files:\s*\[(.*)\]$/ms.exec(text)?.[1] ?? "";
  return { version, path, sha512, fileCount: files.split(",").filter((s) => s.trim()).length };
}

let baseline = null;
let baselineId = null;

for (const mirror of only) {
  console.log(`\n========== ${mirror.id} → ${mirror.base} ==========`);

  // ── 1. 检测链路：latest.yml ──
  const yml = fetchText(`${mirror.base}/latest.yml`);
  if (yml.error || yml.code !== 200) {
    console.log(`✖ 检测失败：${yml.error ?? `HTTP ${yml.code}，body=${(yml.body ?? "").slice(0, 120)}`}`);
    continue;
  }
  const info = parseYml(yml.body);
  console.log(`· 检测 latest.yml → HTTP 200，耗时 ${yml.timeSec}s，${yml.body.length} bytes`);
  console.log(`  version=${info.version} | files=${info.fileCount} 个 | 首个 file.path=${info.path} | sha512=${info.sha512.slice(0, 20)}…`);

  if (!baseline) {
    baseline = yml.body;
    baselineId = mirror.id;
    console.log(`  （基线 = ${mirror.id} 返回内容）`);
  } else {
    console.log(`· 与基线(${baselineId})内容一致 → ${yml.body === baseline ? "✅ 一致" : "❌ 不一致！"}`);
  }

  // ── 2. 下载链路：Range 分片（跟随 302）──
  const p1 = fetchBin(`${mirror.base}/${SETUP}`, { range: "0-1048575", outFile: "/tmp/probe-part1.bin" });
  console.log(
    p1.error
      ? `✖ 下载预检失败：${p1.error}`
      : `· Range 0-1MB（跟随 302）→ HTTP ${p1.code}（期望 206${p1.code === 206 ? " ✅" : "/200 全量说明丢 Range ❌"}）| ${(p1.size / 1024).toFixed(0)}KB | ${p1.timeSec}s | ${p1.speedKBps}KB/s`,
  );

  const p2 = fetchBin(`${mirror.base}/${SETUP}`, { range: "69200000-70200000", outFile: "/tmp/probe-part2.bin" });
  console.log(
    p2.error
      ? `✖ 中段分片失败：${p2.error}`
      : `· Range 66-67MB（中段，跟随 302）→ HTTP ${p2.code}（期望 206${p2.code === 206 ? " ✅" : "/200 全量说明丢 Range ❌"}）| ${(p2.size / 1024).toFixed(0)}KB | ${p2.timeSec}s | ${p2.speedKBps}KB/s`,
  );

  // ── 3. 完整下载 + sha512 校验（--full 时对每个源执行）──
  if (FULL) {
    const full = fetchBin(`${mirror.base}/${SETUP}`, { outFile: "/tmp/probe-full-setup.exe", timeoutSec: 900 });
    if (full.error || full.code !== 200) {
      console.log(`✖ 完整下载失败：${full.error ?? `HTTP ${full.code}`}`);
      continue;
    }
    const expected = info.sha512;
    const actual = createHash("sha512").update(readFileSync("/tmp/probe-full-setup.exe")).digest("base64");
    console.log(
      `· 完整下载 ${(full.size / 1024 / 1024).toFixed(1)}MB → ${full.timeSec}s（${full.speedKBps}KB/s）| sha512 校验 → ${expected && actual === expected ? "✅ 通过" : `❌ 不匹配（期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`}`,
    );
  }
}

console.log("\n===== 汇总 =====");
console.log("检测=latest.yml 200+内容一致 | 下载=Range 206（0-1MB 首段 + 66-67MB 中段）| 完整=FULL 模式 sha512");
if (!existsSync("/tmp/probe-part1.bin")) console.log("（未执行任何 Range 测试）");