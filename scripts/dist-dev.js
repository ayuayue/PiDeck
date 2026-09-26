/**
 * dev 通道（PiDeck Dev）三平台打包入口。
 *
 * 与 stable（PiDeck）双品牌包并存、互不影响：
 * - productName: "PiDeck Dev" → 安装目录 / 快捷方式 / 开始菜单独立
 * - appId: com.ayuayue.pi-desktop-dev → NSIS GUID（由 appId 派生）与通知
 *   AppUserModelID 独立，两通道安装包可并存
 * - 协议 scheme: pideck-dev:// → 注册表关联不与 stable 的 pideck:// 互相抢占
 * - 产物名固定 "PiDeck-Dev-…"（无空格，GitHub/AtomGit 资产 URL 对空格敏感）
 *
 * userData 与 stable **共用** pi-desktop（主进程 index.ts 的刻意决策），
 * 双包切换不丢配置；并行运行依赖按版本互斥的单实例锁。
 *
 * 配置策略：只维护与 package.json build 字段的**差异项**，运行时读取主配置
 * 深合并后写临时配置文件传给 electron-builder（--config 外部文件是完整配置、
 * 不与 package.json 合并）。不做全量复制——主配置改 asar/extraResources 时
 * dev 包自动跟随，避免两份配置漂移。
 *
 * 用法（剩余参数原样透传给 electron-builder）：
 *   node scripts/dist-dev.js --win nsis portable zip
 *   node scripts/dist-dev.js --mac dmg zip --x64
 *   node scripts/dist-dev.js --linux AppImage deb tar.gz --arm64
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.resolve(__dirname, "..");

// dev 通道与 stable 的差异项（子对象按一层浅合并，保留 icon/target 等既有键）。
// artifactName 显式含 ${arch}：mac/linux 多架构分 job 构建，模板无 ${arch} 时
// x64/arm64 产物同名互相覆盖（stable 配置 win 模板不含 ${arch} 是因为 win 只发 x64）。
const DEV_OVERRIDES = {
	productName: "PiDeck Dev",
	appId: "com.ayuayue.pi-desktop-dev",
	protocols: [{ name: "PiDeck Dev Agent Link", schemes: ["pideck-dev"] }],
	win: { artifactName: "PiDeck-Dev-${version}-win.${ext}" },
	nsis: { artifactName: "PiDeck-Dev-${version}-setup.${ext}" },
	portable: { artifactName: "PiDeck-Dev-${version}-portable.${ext}" },
	mac: { artifactName: "PiDeck-Dev-${version}-${arch}.${ext}" },
	linux: { artifactName: "PiDeck-Dev-${version}-${arch}.${ext}" },
};

function buildDevConfig() {
	const baseConfig = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build;
	const devConfig = { ...baseConfig };
	for (const [key, value] of Object.entries(DEV_OVERRIDES)) {
		const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
		devConfig[key] = isPlainObject ? { ...(baseConfig[key] ?? {}), ...value } : value;
	}
	return devConfig;
}

function run(args) {
	if (!args.length) {
		console.error("用法：node scripts/dist-dev.js --win nsis portable zip [其余 electron-builder 参数透传]");
		process.exit(1);
	}

	// 配置文件里 files/extraResources/afterPack 的相对路径均按项目根（package.json 所在）
	// 解析，与配置文件自身位置无关，写到系统临时目录安全。
	const configPath = path.join(os.tmpdir(), `pideck-dev-builder-config-${process.pid}.json`);
	fs.writeFileSync(configPath, JSON.stringify(buildDevConfig(), null, "\t"));

	console.log(`[1/3] 构建代码（注入 dev 构建标记）…`);
	try {
		execSync("npm run build", {
			cwd: root,
			stdio: "inherit",
			shell: true,
			env: { ...process.env, PIDECK_DEV_BUILD: "1" },
		});

		console.log(`\n[2/3] electron-builder ${args.join(" ")}（dev 配置）…`);
		execSync(`npx electron-builder ${args.join(" ")} --config "${configPath}"`, {
			cwd: root,
			stdio: "inherit",
			shell: true,
		});
	} finally {
		fs.rmSync(configPath, { force: true });
	}

	console.log(`\n[3/3] ✅ PiDeck Dev 打包完成！产物在 release/ 目录`);
}

module.exports = { run, buildDevConfig, DEV_OVERRIDES };

if (require.main === module) {
	run(process.argv.slice(2));
}
