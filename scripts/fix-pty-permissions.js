// @ts-check
/**
 * node-pty v1.1.0 的预构建 spawn-helper 二进制文件在 npm install 后会丢失可执行权限，
 * 导致 pty.spawn() 调用 posix_spawnp 失败，终端完全不可用。
 * 此外，unixTerminal.js 中的 helperPath 替换逻辑在打包后路径已含 app.asar.unpacked
 * 时会被错误重复替换（app.asar.unpacked → app.asar.unpacked.unpacked），
 * 进一步导致 spawn-helper 找不到而失败。
 * 此脚本在 postinstall 时一并修复这两个问题。
 */
const fs = require("node:fs");
const path = require("node:path");

const ptyDir = path.join(__dirname, "..", "node_modules", "node-pty");

// ── 修复 1：spawn-helper 可执行权限 ──
fixSpawnHelperPermissions();

// ── 修复 2：unixTerminal.js helperPath 重复替换 bug ──
fixUnixTerminalHelperPath();

function fixSpawnHelperPermissions() {
	const prebuildsDir = path.join(ptyDir, "prebuilds");
	if (!fs.existsSync(prebuildsDir)) {
		console.warn("[fix-pty] prebuilds dir not found, skipping");
		return;
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
}

function fixUnixTerminalHelperPath() {
	const unixTerminalPath = path.join(ptyDir, "lib", "unixTerminal.js");
	if (!fs.existsSync(unixTerminalPath)) {
		console.warn("[fix-pty] unixTerminal.js not found, skipping helperPath fix");
		return;
	}

	let content = fs.readFileSync(unixTerminalPath, "utf8");

	// 原始代码（两条无条件 replace）：
	//   helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
	//   helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');
	// 当路径已包含 app.asar.unpacked 时，第一条会将 app.asar.unpacked 误替换为
	// app.asar.unpacked.unpacked，导致 spawn-helper 路径指向不存在的目录。
	const oldReplaceBlock =
		`helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');`;

	const newReplaceBlock =
		`if (helperPath.includes('app.asar') && !helperPath.includes('app.asar.unpacked')) {
  helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
}
if (helperPath.includes('node_modules.asar') && !helperPath.includes('node_modules.asar.unpacked')) {
  helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');
}`;

	// 如果文件已被修补过（包含新的条件逻辑），则跳过
	if (content.includes("!helperPath.includes('app.asar.unpacked')")) {
		console.log("[fix-pty] unixTerminal.js already patched, skipping");
		return;
	}

	if (!content.includes(oldReplaceBlock)) {
		console.warn("[fix-pty] unixTerminal.js unexpected content, skipping helperPath fix");
		console.warn("[fix-pty] Expected to find: " + JSON.stringify(oldReplaceBlock));
		return;
	}

	content = content.replace(oldReplaceBlock, newReplaceBlock);
	fs.writeFileSync(unixTerminalPath, content, "utf8");
	console.log("[fix-pty] Patched unixTerminal.js helperPath replace logic");
}
