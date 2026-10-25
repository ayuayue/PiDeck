/**
 * file: 本地包的 `npm run build` 调用方式（纯函数，便于单测）。
 *
 * 为什么单独抽出来：npm run 的 PATH 是**从脚本 cwd 逐级向上**拼 node_modules/.bin
 * 的。交叉打包（--target-os/--target-arch）时闭包入口来自临时解析目录，其中 file:
 * 本地包是**指向仓库源码目录的符号链接**：
 *
 *   <tmp>/node_modules/dsh-tool-pwsh-persistent → <repo>/packages/dsh-tool-pwsh-persistent
 *
 * 这条逻辑路径的祖先里没有仓库的 node_modules/.bin，于是构建脚本（tsc）在交叉模式
 * 下直接报 `'tsc' 不是内部或外部命令`。2026-09-22 v0.7.7 补发二次失败就是这一条：
 * 不是缺包，是 npm 按符号链接路径找不到 .bin。native 模式一直没暴露，因为符号链接
 * 就位于仓库自己的 node_modules 下，祖先链上恰好有仓库 .bin。
 *
 * 所以 cwd 必须用 realpathSync(dir)：构建发生在包的真实目录（源码所在处），祖先链上
 * 自然有仓库 node_modules/.bin，且编译产物 lib/ 正好落回仓库包目录（归档需要它）。
 * 前提是仓库根装了完整 dev 依赖（tsc / @types/node / @deepseek-ai/* 类型）——见
 * .github/workflows/{release,publish-dsh-runtime}.yml 里「不做 --omit=dev」的注释。
 */
import { realpathSync } from "node:fs";

/**
 * 构造本地包的构建调用参数。
 *
 * @param {string} dir 闭包入口目录（交叉模式下可能是符号链接）
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {{ command: string, args: string[], cwd: string }}
 */
export function localPackageBuildInvocation(dir, { platform = process.platform } = {}) {
	if (typeof dir !== "string" || dir.length === 0) {
		throw new TypeError("localPackageBuildInvocation: dir 必须是非空字符串");
	}
	// 解析失败（路径被删等）时退回逻辑路径：让 npm 报更直观的错误，不在这里吞成 TypeError。
	let cwd = dir;
	try {
		cwd = realpathSync(dir);
	} catch {
		cwd = dir;
	}
	// Windows 上 npm 是 npm.cmd shim，CreateProcess 不经 cmd.exe 不能执行批处理（EINVAL），
	// 必须显式走 cmd.exe；不用 shell:true——Node 24 传参会触发 DEP0190（参数不转义只拼接），
	// 而这里的参数全是固定常量，无用户输入，无注入面。
	return platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", "run", "build"], cwd } : { command: "npm", args: ["run", "build"], cwd };
}
