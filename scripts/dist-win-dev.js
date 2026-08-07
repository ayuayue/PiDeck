/**
 * dist:win:dev 包装脚本：构建并打包独立的 Dev 验证版安装包。
 *
 * 与正式版（PiDeck）完全隔离，互不影响：
 * - productName: PiDeckDev → 安装目录 %LOCALAPPDATA%\Programs\PiDeckDev、快捷方式名独立
 * - appId: com.ayuayue.pi-desktop-dev → 通知中心归属（AppUserModelID）独立
 * - 配置目录: %APPDATA%\pi-desktop-dev → 与 dev 模式共用，复用现有项目/模型/会话配置
 *
 * 注意：dev 与 dev 构建版共享配置目录，同版本单实例锁（instance-locks/0.6.7.lock）互斥，
 * 运行时两者不能同时开启。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

console.log(`[1/3] 构建代码（注入 dev 构建标记）…`);
execSync("npm run build", {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: { ...process.env, PIDECK_DEV_BUILD: "1" },
});

console.log(`\n[2/3] electron-builder --win nsis …`);
execSync(
	`npx electron-builder --win nsis --config.productName=PiDeckDev --config.appId=com.ayuayue.pi-desktop-dev`,
	{ cwd: root, stdio: "inherit", shell: true },
);

console.log(`\n[3/3] ✅ Dev 版打包完成！产物在 release/ 目录（PiDeckDev Setup *.exe）`);
