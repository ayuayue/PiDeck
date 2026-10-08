import { posix, win32 } from "node:path";

/**
 * pi 自更新的「更新通道」判定（纯函数：零 Electron / 零磁盘依赖，可裸 Node 单测）。
 *
 * 为什么需要分派：`pi update --self` 并非对所有安装形态都可用——
 * - **bun 全局安装**（`bun install -g @earendil-works/pi-coding-agent`，可执行落
 *   `~/.bun/bin`）：pi 在 Windows 上只支持 npm/pnpm 自更新（pi `config.js` 的
 *   detectInstallMethod + Windows gate），bun 形态直接报错退出。需要 PiDeck 代跑
 *   `bun install -g <pkg>@<ver>`（参数与 pi 自身 bun 分支一致）。
 * - **旧引导前缀副本**（2026-10 之前的引导用 `npm install -g --prefix=<userData>/pi-runtime/pi-global`）：
 *   pi 的 npm 自更新只在 POSIX 按 `lib/node_modules` 形状推断前缀，Windows 显式不推断
 *   （pi `getInferredNpmInstall` 的注释），`npm install -g` 会落到用户真实 npm 全局目录，
 *   前缀里的旧副本原地不动（表现为「更新成功但版本没变」）。需要带 `--prefix` 代跑 npm。
 * - 其余（npm/pnpm/yarn 全局、pi 官方 managed 安装、自定义路径、WSL）：pi 自己能正确
 *   自更新，保持 `pi update --self`。
 *
 * 判定依据是 pi **可执行文件路径的形状**（与 pi detectInstallMethod 同源的特征），而不是
 * PiLocator 的 source 标签：source 只区分 package-manager/portable，分不出 bun 与 npm。
 */
export type PiSelfUpdateChannel =
	| { kind: "pi-self" }
	/** bun 全局安装：PiDeck 代跑 bun；bunCommand 与 pi 可执行同目录（bun 的全局 bin 必有 bun 本体）。 */
	| { kind: "bun-global"; bunCommand: string }
	/** 旧引导前缀安装：PiDeck 带 --prefix 代跑 npm；prefixDir 即当初 --prefix 的值。 */
	| { kind: "portable-prefix"; prefixDir: string };

/** bun 布局特征：全局 bin（`~/.bun/bin`）或其包目录（`…/install/global/node_modules`，软链解析后）。 */
const BUN_PATH_PATTERN = /[\\/]\.bun[\\/]|[\\/]install[\\/]global[\\/]node_modules[\\/]/;
/** 旧引导前缀布局：`<prefix>/pi.cmd`（Windows）或 `<prefix>/bin/pi`（POSIX），层级见 piRuntimePaths。 */
const PORTABLE_PREFIX_PATTERN = /^(.*?[\\/]pi-runtime[\\/]pi-global)(?:[\\/].*)?$/i;

export function resolvePiSelfUpdateChannel(command: string, platform: NodeJS.Platform = process.platform): PiSelfUpdateChannel {
	// 裸命令名（所有候选都未命中时的兜底形态）与 wsl:// 标记无从分类；WSL 内是 Linux
	// 环境，pi 自身的 Windows gate 不适用，交给 `pi update --self` 自己判断。
	if (!command || command.startsWith("wsl://") || !/[\\/]/.test(command)) return { kind: "pi-self" };
	if (BUN_PATH_PATTERN.test(command.replace(/\\/g, "/"))) {
		// 分隔符跟随命令自身形态（而非宿主平台）：POSIX 形态路径即使在 Windows 主机上
		//（WSL/跨平台测试）也要拼出 POSIX 分隔符，否则生成的 bunCommand 无法命中。
		const pathApi = command.includes("\\") ? win32 : posix;
		return { kind: "bun-global", bunCommand: pathApi.join(pathApi.dirname(command), platform === "win32" ? "bun.exe" : "bun") };
	}
	const portableMatch = PORTABLE_PREFIX_PATTERN.exec(command);
	if (portableMatch) return { kind: "portable-prefix", prefixDir: portableMatch[1] };
	return { kind: "pi-self" };
}
