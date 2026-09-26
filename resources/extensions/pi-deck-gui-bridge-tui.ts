/**
 * pi-deck-gui-bridge —— pi-tui 运行时加载器。
 *
 * **为什么不能直接 `import { Text } from "@earendil-works/pi-tui"`**：
 * pi 扩展由 jiti 加载，扩展里的裸 import 会从**扩展文件所在目录向上**查找 node_modules。
 * 本仓库（以及 <userData>/builtin-extensions 覆盖层）里都没有 pi-tui，
 * 静态 import 会直接 MODULE_NOT_FOUND → pi 启动失败。
 *
 * **为什么不能自己装一份 pi-tui**：桥与 pi 内部必须是**同一份模块实例**，
 * 否则 `instanceof` 全部为 false，语义化适配器退化成纯 ANSI（§6.3 问题 A）。
 *
 * 因此：**先定位 pi 自己的安装位置，再从那里解析 pi-tui**。
 * Phase 0 S3 已实测该路径下 `instanceof` 成立且与 pi 内部同实例。
 *
 * 加载失败时返回 null，桥整体降级为「不工作」——**绝不抛错影响 pi**（§14.5）。
 * 适配器另有 `constructor.name` + 形状探测兜底（§6.3 对策 2），故 pi-tui 加载失败
 * 只损失 `instanceof` 的精度，不会让桥完全失效。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi-tui 的关键导出（只声明桥真正用到的部分，避免依赖完整 .d.ts）。 */
export type PiTuiModule = {
	Text: new (...args: unknown[]) => PiTuiComponent;
	TruncatedText: new (...args: unknown[]) => PiTuiComponent;
	Markdown: new (...args: unknown[]) => PiTuiComponent;
	Box: new (...args: unknown[]) => PiTuiComponent & { children?: PiTuiComponent[] };
	VStack: new (...args: unknown[]) => PiTuiComponent & { children?: PiTuiComponent[] };
	HStack: new (...args: unknown[]) => PiTuiComponent & { children?: PiTuiComponent[] };
	Spacer: new (...args: unknown[]) => PiTuiComponent;
	Input: new (...args: unknown[]) => PiTuiComponent & { getValue?: () => string };
	Editor: new (...args: unknown[]) => PiTuiComponent;
	SelectList: new (...args: unknown[]) => PiTuiComponent & {
		setSelectedIndex?: (index: number) => void;
		setFilter?: (filter: string) => void;
		getSelectedItem?: () => { value: string; label: string } | null;
	};
	SettingsList: new (...args: unknown[]) => PiTuiComponent;
	ScrollView: new (...args: unknown[]) => PiTuiComponent & { children?: PiTuiComponent[] };
	Loader: new (...args: unknown[]) => PiTuiComponent;
	CancellableLoader: new (...args: unknown[]) => PiTuiComponent;
	Image: new (...args: unknown[]) => PiTuiComponent;
	Container: new (...args: unknown[]) => PiTuiComponent & { children?: PiTuiComponent[] };
	getKeybindings?: () => { matches?: (data: string, id: string) => boolean } | undefined;
	Key?: Record<string, string>;
};

/** pi-tui 组件的最小结构（只依赖公开契约，不依赖完整 .d.ts）。 */
export type PiTuiComponent = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
	constructor?: { name?: string };
};

/** 解析结果：成功给出模块与来源，失败给出原因（供日志，不影响 pi）。 */
export type PiTuiLoadResult = { module: PiTuiModule; resolvedPath: string; via: string } | { module: null; error: string };

let cached: PiTuiLoadResult | null = null;

/**
 * 收集「pi 安装位置」的候选锚点文件。
 *
 * 按可靠性排序：
 * 1. `PIDECK_BRIDGE_PI_PATH` —— PiDeck spawn pi 时注入，最可靠（不猜）；
 * 2. `process.argv` 里任何形似 pi 安装路径的条目 —— 真实 pi 进程里
 *    `argv[1]` 是 `<pi>/dist/bundle/cli.js`；WSL / 自定义启动器下可能是别的下标；
 * 3. `process.execPath` 同级的 npm 全局 node_modules —— 兜底（全局安装布局）。
 *
 * 每个锚点只用于 `createRequire` 的解析基点，**不要求它本身存在**：
 * `createRequire` 只用它的目录去向上找 node_modules（已实测）。
 *
 * ⚠️ 这里**刻意不用 `import.meta.url` / `require.main`**：
 * 扩展既可能被 jiti 按 ESM 加载，也可能被测试按 CJS 转译执行，
 * 两者对 `import.meta` / `require` 的可用性相反。只用 `process.*` 才两边都安全。
 */
function collectAnchorCandidates(): { anchor: string; via: string }[] {
	const anchors: { anchor: string; via: string }[] = [];
	const seen = new Set<string>();
	const push = (anchor: string, via: string): void => {
		const normalized = anchor.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		anchors.push({ anchor: normalized, via });
	};

	const explicit = process.env.PIDECK_BRIDGE_PI_PATH?.trim();
	if (explicit) push(explicit, "PIDECK_BRIDGE_PI_PATH");

	// argv 里任何指向 pi 包的路径都是好锚点：优先含 "pi-coding-agent" 的，
	// 再退到 argv[1]（常规启动器下就是 pi 的 CLI 入口）。
	const argvEntries = process.argv.slice(1).filter((arg): arg is string => typeof arg === "string" && arg.length > 0);
	for (const entry of argvEntries) {
		if (/pi-coding-agent/.test(entry)) push(entry, `process.argv（含 pi-coding-agent）`);
	}
	if (argvEntries[0]) push(argvEntries[0], "process.argv[1]");

	// 兜底：node 可执行文件同级的 npm 全局布局
	// （Windows: <node>/../npm/node_modules；Unix: <node>/../lib/node_modules）
	try {
		const execDir = dirname(process.execPath);
		for (const rel of [
			join(execDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
			join(execDir, "..", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
			join(execDir, "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		]) {
			if (existsSync(rel)) push(rel, `execPath 兜底: ${rel}`);
		}
	} catch {
		// 忽略
	}

	// 兜底：npm 全局前缀的**标准位置**。
	// Windows 的 npm 全局前缀是 `%APPDATA%\npm`（不在 node 安装目录旁边），
	// 只查 execPath 同级会漏掉 —— 这是最常见的一种漏检。
	try {
		const globalRoots: (string | null)[] = [];
		const appData = process.env.APPDATA;
		if (appData) globalRoots.push(join(appData, "npm", "node_modules"));
		const home = process.env.USERPROFILE || process.env.HOME;
		if (home) globalRoots.push(join(home, ".npm-global", "lib", "node_modules"));
		for (const root of globalRoots) {
			if (!root) continue;
			const rel = join(root, "@earendil-works", "pi-coding-agent", "package.json");
			if (existsSync(rel)) push(rel, `npm 全局前缀: ${rel}`);
		}
	} catch {
		// 忽略
	}

	// 最后兜底：以 cwd 为基点（pi 的 cwd 常是项目目录，node_modules 可能在其上层）
	push(join(process.cwd(), "__pideck_bridge_anchor__.js"), "cwd 兜底");

	return anchors;
}

/**
 * 从某锚点解析 pi-tui 的绝对路径；失败返回 null。
 *
 * 三条路径依次尝试：
 * 1. 直接 `resolve("@earendil-works/pi-tui")` —— 常见布局（pi-tui 有 require 条件）；
 * 2. 先解析 pi-coding-agent 再由它解析 —— 处理 pi-tui 未提升的布局；
 *    ⚠️ pi-coding-agent 是 **ESM-only**（`exports` 只有 `import` 条件），
 *    CJS 的 `resolve` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，故这条常失败；
 * 3. **文件系统探测**：锚点目录向上逐级找 `node_modules/@earendil-works/pi-tui/package.json`。
 *    不依赖任何 resolve 语义，对 ESM-only / 各种提升布局都成立 —— 这是最可靠的一条。
 */
function resolveFromAnchor(anchor: string): string | null {
	// 1) 直接解析 pi-tui
	try {
		const req = createRequire(anchor);
		return req.resolve("@earendil-works/pi-tui");
	} catch {
		// 继续
	}
	// 2) 经 pi-coding-agent 解析
	try {
		const req = createRequire(anchor);
		const piBase = req.resolve("@earendil-works/pi-coding-agent");
		const piReq = createRequire(piBase);
		return piReq.resolve("@earendil-works/pi-tui");
	} catch {
		// 继续
	}
	// 3) 文件系统探测：从锚点目录向上找 pi-tui 的 package.json
	try {
		let dir = dirname(anchor);
		for (let depth = 0; depth < 12; depth += 1) {
			const candidate = join(dir, "node_modules", "@earendil-works", "pi-tui", "package.json");
			if (existsSync(candidate)) return candidate;
			// 也接受「锚点本身就在 node_modules 里」的布局：
			// <root>/node_modules/@earendil-works/pi-coding-agent/... → <root>/node_modules/@earendil-works/pi-tui
			const sibling = join(dir, "@earendil-works", "pi-tui", "package.json");
			if (existsSync(sibling)) return sibling;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// 忽略
	}
	return null;
}

/** 逐个锚点尝试，返回首个成功的解析结果。 */
function resolvePiTuiPath(): { path: string; via: string } | null {
	for (const { anchor, via } of collectAnchorCandidates()) {
		const resolved = resolveFromAnchor(anchor);
		if (resolved) return { path: resolved, via: `${via} → ${resolved}` };
	}
	return null;
}

/**
 * 加载 pi-tui 模块（进程内只解析一次，结果缓存）。
 *
 * 返回 `{ module: null }` 表示加载失败：桥应继续工作，适配器退化为形状判定。
 */
export function loadPiTui(): PiTuiLoadResult {
	if (cached) return cached;
	const resolved = resolvePiTuiPath();
	if (!resolved) {
		cached = { module: null, error: "无法定位 @earendil-works/pi-tui（已尝试 env / argv[1] / require.main / execPath 兜底）" };
		return cached;
	}
	try {
		const req = createRequire(resolved.path);
		const mod = req(resolved.path) as PiTuiModule;
		if (!mod || typeof mod.Text !== "function") {
			cached = { module: null, error: `pi-tui 已解析但缺少 Text 导出: ${resolved.path}` };
			return cached;
		}
		cached = { module: mod, resolvedPath: resolved.path, via: resolved.via };
		return cached;
	} catch (error) {
		cached = { module: null, error: `加载 pi-tui 失败: ${error instanceof Error ? error.message : String(error)}` };
		return cached;
	}
}

/** 已解析到的 pi-tui 路径（仅用于诊断日志；未加载时为 null）。 */
export function piTuiResolvedPath(): string | null {
	if (!cached || !cached.module) return null;
	return cached.resolvedPath;
}

/** 已解析来源描述（诊断用）。 */
export function piTuiResolvedVia(): string | null {
	if (!cached || !cached.module) return null;
	return cached.via;
}

/** 仅测试用：清空缓存。 */
export function resetPiTuiCacheForTests(): void {
	cached = null;
}