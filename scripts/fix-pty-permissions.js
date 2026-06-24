// @ts-check
/**
 * node-pty v1.1.0 的预构建 spawn-helper 二进制文件在 npm install 后会丢失可执行权限，
 * 导致 pty.spawn() 调用 posix_spawnp 失败，终端完全不可用。
 * 此脚本在 postinstall 时修复所有平台的 spawn-helper 权限。
 */
const fs = require("node:fs");
const path = require("node:path");

const prebuildsDir = path.join(
	__dirname,
	"..",
	"node_modules",
	"node-pty",
	"prebuilds",
);

if (!fs.existsSync(prebuildsDir)) {
	console.warn("[fix-pty] prebuilds dir not found, skipping");
	process.exit(0);
}

const entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
let fixed = 0;
for (const entry of entries) {
	if (!entry.isDirectory()) continue;
	const helperPath = path.join(prebuildsDir, entry.name, "spawn-helper");
	if (!fs.existsSync(helperPath)) continue;
	try {
		const stat = fs.statSync(helperPath);
		// 检查是否已有执行权限（owner execute bit）
		if (!(stat.mode & fs.constants.S_IXUSR)) {
			fs.chmodSync(helperPath, 0o755);
			fixed++;
		}
	} catch {
		// ignore
	}
}

if (fixed > 0) {
	console.log(`[fix-pty] Fixed ${fixed} spawn-helper permissions`);
} else {
	console.log("[fix-pty] All spawn-helper already executable");
}
