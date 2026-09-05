/**
 * 完整下载 + sha512 校验（临时）：三个镜像并行下载 PiDeck-0.7.3-setup.exe，
 * 用 latest.yml 声明的 sha512（base64）校验整包，与 electron-updater 下载后校验一致。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETUP = "PiDeck-0.7.3-setup.exe";
const MIRRORS = [
  { id: "ghfast", base: "https://ghfast.top/https://github.com/ayuayue/PiDeck/releases/latest/download" },
  { id: "ghproxy-net", base: "https://ghproxy.net/https://github.com/ayuayue/PiDeck/releases/latest/download" },
  { id: "ghproxy-cxkpro", base: "https://ghproxy.cxkpro.top/https://github.com/ayuayue/PiDeck/releases/latest/download" },
];

function fetchText(url) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn("curl", ["-sL", "--noproxy", "*", "-x", "", "--max-time", "30", url]);
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("close", (code) => resolve({ code, body: Buffer.concat(chunks).toString("utf8") }));
  });
}

// 先取 expected sha512（任一镜像的 latest.yml，已实测三源内容一致）
const yml = await fetchText(`${MIRRORS[0].base}/latest.yml`);
const sha512 = /^sha512:\s*(\S+)/m.exec(yml.body)?.[1] ?? "";
if (!sha512) {
  console.error("无法解析 latest.yml sha512");
  process.exit(1);
}
console.log(`目标：${SETUP}（138.3MB），期望 sha512=${sha512.slice(0, 24)}…\n`);

// 并行下载三个源
const results = await Promise.all(
  MIRRORS.map((m) => {
    const out = join(mkdtempSync(join(tmpdir(), "mirror-full-")), SETUP);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn("curl", ["-sL", "--noproxy", "*", "-x", "", "--max-time", "900", "-o", out, "-w", "%{http_code}", `${m.base}/${SETUP}`]);
      let httpCode = "";
      child.stdout.on("data", (d) => (httpCode = d.toString()));
      child.on("close", (code) => {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const size = existsSync(out) ? readFileSync(out).length : 0;
        let shaOk = null;
        if (size > 0) {
          const actual = createHash("sha512").update(readFileSync(out)).digest("base64");
          shaOk = actual === sha512;
        }
        resolve({ id: m.id, secs, size, httpCode: httpCode || String(code ?? "?"), shaOk, out });
      });
    });
  }),
);

console.log("===== 完整下载 + sha512 校验结果 =====");
for (const r of results) {
  const mb = (r.size / 1024 / 1024).toFixed(1);
  const speed = (r.size / 1024 / Number(r.secs) / 1024).toFixed(2);
  console.log(
    `${r.id.padEnd(16)} HTTP ${r.httpCode} | ${mb}MB | ${r.secs}s | ${speed}MB/s | sha512 ${r.shaOk === null ? "（未生成）" : r.shaOk ? "✅ 通过" : "❌ 不匹配"}`,
  );
  rmSync(join(r.out, ".."), { recursive: true, force: true });
}