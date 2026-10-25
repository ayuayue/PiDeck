/**
 * sharp 原生绑定打包兼容补丁（纯函数，便于单测）。
 *
 * 问题背景：sharp 0.35 的 @img/sharp-win32-x64/index.cjs 通过相对路径
 * `require('./lib/sharp-win32-x64-<ver>.node')` 加载原生绑定。打包后该文件
 * 经 asar 虚拟路径加载（asar 内副本，asar.unpacked 为镜像），__dirname 是
 * asar 虚拟路径；Electron 的 dlopen 补丁会把 .node 复制到 %TEMP% 再加载，
 * 同目录 libvips-*.dll 不会跟随复制 → ERR_DLOPEN_FAILED（DSH host 启动即退）。
 * 注意：fs.realpathSync 对 asar 内路径不解析 unpacked，因此不能依赖它；
 * 这里直接用 process.resourcesPath 构造 asar.unpacked 的真实磁盘路径再 require，
 * 保证 .node 与 DLL 同目录加载（node-pty 走 node-gyp-build 同理）。
 */

/**
 * 对 @img/sharp-win32-x64/index.cjs 内容应用 resourcesPath 补丁。
 * @param {string} content index.cjs 原文
 * @returns {string} 补丁后内容
 * @throws 内容格式与预期不符时抛错（sharp 升级后结构变化 = 补丁静默失效 = 回归，宁可打包失败）
 */
function patchSharpIndexCjs(content) {
	// 已打过补丁（幂等：重复打包/多平台复用同一 unpacked 目录时不二次处理）
	if (content.includes("process.resourcesPath")) {
		return content;
	}
	const match = content.match(/^module\.exports = require\('\.\/lib\/([^']+\.node)'\);$/m);
	if (!match) {
		throw new Error(`sharp index.cjs 格式不符，resourcesPath 补丁无法应用（请检查 sharp/@img 版本升级）：\n${content.slice(0, 200)}`);
	}
	const nodeFile = match[1];
	return [
		"// patched by pi-desktop after-pack: 打包环境下 __dirname 为 asar 虚拟路径，",
		"// 相对 require .node 会被 Electron 复制到 %TEMP% 导致 libvips DLL 丢失，",
		"// 这里直接用 process.resourcesPath 定位 asar.unpacked 真实路径再加载。",
		`const path = require('node:path');`,
		`module.exports = require(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', '${nodeFile}'));`,
		"",
	].join("\n");
}

module.exports = { patchSharpIndexCjs };
