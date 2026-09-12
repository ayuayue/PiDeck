import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
	BUILT_IN_EXTENSIONS_OVERLAY_DIR_NAME,
	readVerifiedArtifact,
	type BuiltInExtensionsManifest,
} from "./builtInExtensionsManifest";

/**
 * PiDeck 内置扩展（随应用 resources 分发，不再复制到 ~/.pi/agent/extensions）。
 * 启动 RPC 时通过可重复的 `--extension/-e` 注入，避免污染用户全局 pi。
 */
export const BUILT_IN_EXTENSIONS = [
	"pi-deck-request-size-recovery.ts",
	"pi-deck-ask-question.ts",
	"pi-deck-goal-mode.ts",
	"pi-deck-nul-redirect-fix.ts",
	"pi-deck-plan-mode.ts",
	"pi-deck-retry-no-body.ts",
	"pi-deck-security-gate.ts",
	"pi-deck-session-title.ts",
	"pi-deck-subagents.ts",
	"pi-deck-todo.ts",
	"pi-deck-trash-guard.ts",
	"pi-deck-vision.ts",
] as const;

export type BuiltInExtensionName = (typeof BUILT_IN_EXTENSIONS)[number];

export type BuiltInExtensionPathRoots = {
	/** 开发态 app 根（含 resources/extensions） */
	appPath: string;
	/** 打包态 process.resourcesPath（extraResources 的 extensions/） */
	resourcesPath: string;
	isDev: boolean;
	/**
	 * 覆盖层目录（`<userData>/builtin-extensions`，内置扩展热更新的落点）。
	 * 目录内存在同名文件时优先返回它，`-e` 注入路径随之指向覆盖层，重启会话即生效。
	 * 缺省（测试/探针）表示不使用覆盖层，行为与引入热更新前一致。
	 */
	overlayDir?: string;
};

/** 校验 source 是否为允许的内置扩展 basename（防路径穿越）。 */
export function isBuiltInExtensionName(source: string): source is BuiltInExtensionName {
	const name = basename(source.trim());
	return (BUILT_IN_EXTENSIONS as readonly string[]).includes(name) && name === source.trim();
}

/**
 * 覆盖层目录：`<userData>/builtin-extensions`。
 * 传 userData 而不是直接读 electron，保持纯函数、可被 node --test 直接加载。
 */
export function resolveBuiltInExtensionsOverlayDir(userDataDir: string): string {
	return join(userDataDir, BUILT_IN_EXTENSIONS_OVERLAY_DIR_NAME);
}

/**
 * 覆盖层可用性缓存（单个目录，进程内）。
 *
 * 覆盖层是**完整快照**：扩展之间存在相对 import（pi-deck-todo.ts → ./pi-deck-todo-state.ts），
 * 只判断「同名文件存在」不够——缺一个文件就会让 pi 解析不到依赖。因此必须整份校验
 * （清单可解析 + 每个声明的文件 bytes/sha256 吻合），校验不过一律当没有覆盖层。
 *
 * 校验要读全部十几个文件，而路径解析会对每个扩展名各调一次，故按目录缓存结果；
 * 热更新器写完/还原覆盖层后调用 invalidate 失效。
 */
let overlayArtifactCache: { dir: string; manifest: BuiltInExtensionsManifest | null } | null = null;

/** 供热更新器在写盘/还原后调用，让下一次路径解析重新校验。 */
export function invalidateBuiltInExtensionsOverlayCache(): void {
	overlayArtifactCache = null;
}

/** 覆盖层的有效清单（校验通过才有值；结果按目录缓存）。 */
function overlayArtifact(overlayDir: string): BuiltInExtensionsManifest | null {
	if (overlayArtifactCache?.dir === overlayDir) return overlayArtifactCache.manifest;
	const manifest = readVerifiedArtifact(overlayDir);
	overlayArtifactCache = { dir: overlayDir, manifest };
	return manifest;
}

/**
 * 当前生效的内置扩展包版本（覆盖层优先，否则随包内置）。
 * 版本号由 resources/extensions/extensions-manifest.json 维护，**不跟 PiDeck 应用版本走**。
 * 清单缺失（旧安装包）返回 null，此时扩展列表版本列回退「-」。
 */
export function readEffectiveBuiltInExtensionsVersion(
	roots: BuiltInExtensionPathRoots,
): string | null {
	if (roots.overlayDir) {
		const overlay = overlayArtifact(roots.overlayDir);
		if (overlay) return overlay.version;
	}
	return readVerifiedArtifact(resolveBuiltInExtensionsDir(roots))?.version ?? null;
}

/** 内置扩展目录绝对路径（不含文件名）——覆盖层比对与热更新读取内置清单时使用。 */
export function resolveBuiltInExtensionsDir(roots: BuiltInExtensionPathRoots): string {
	return roots.isDev
		? join(roots.appPath, "resources", "extensions")
		: join(roots.resourcesPath, "extensions");
}

/**
 * 解析单个内置扩展在本机磁盘上的绝对路径。
 * 覆盖层（热更新）优先 → 开发态 appPath/resources/extensions → 打包态 resourcesPath/extensions。
 */
export function resolveBuiltInExtensionPath(
	extensionName: string,
	roots: BuiltInExtensionPathRoots,
): string {
	const name = basename(extensionName.trim());
	if (!isBuiltInExtensionName(name)) {
		throw new Error(`非法内置扩展名: ${extensionName}`);
	}
	// 覆盖层优先：热更新写入的版本必须真正参与 -e 注入，否则「更新成功」只是自欺。
	// 但要整份校验通过才认——半截覆盖层（缺文件/被外部改动）会让 pi 解析不到相对 import。
	if (roots.overlayDir && overlayArtifact(roots.overlayDir)) {
		return join(roots.overlayDir, name);
	}
	return join(resolveBuiltInExtensionsDir(roots), name);
}

/**
 * 返回当前应注入到 pi RPC 的内置扩展绝对路径列表。
 * - removedBuiltInExtensions 中的跳过
 * - 源文件缺失的跳过（打日志由调用方处理）
 * - piRpcNoExtensions 由调用方决定是否整段跳过
 */
export function listActiveBuiltInExtensionPaths(
	roots: BuiltInExtensionPathRoots,
	removedBuiltInExtensions: readonly string[] = [],
): string[] {
	const removed = new Set(
		removedBuiltInExtensions.map((item) => basename(item.trim())).filter(Boolean),
	);
	const paths: string[] = [];
	for (const name of BUILT_IN_EXTENSIONS) {
		if (removed.has(name)) continue;
		const fullPath = resolveBuiltInExtensionPath(name, roots);
		if (!existsSync(fullPath)) continue;
		paths.push(fullPath);
	}
	return paths;
}

/**
 * 把内置扩展路径追加为可重复的 `--extension <path>`。
 * pi 文档：`--no-extensions` 只关自动发现，显式 -e 仍有效；
 * 但 PiDeck 约定 piRpcNoExtensions 时连内置也不注入（诊断干净）。
 */
export function appendBuiltInExtensionArgs(
	args: readonly string[],
	extensionPaths: readonly string[],
	options: { noExtensions?: boolean } = {},
): string[] {
	if (options.noExtensions || extensionPaths.length === 0) return [...args];
	const next = [...args];
	for (const extensionPath of extensionPaths) {
		const trimmed = extensionPath.trim();
		if (!trimmed) continue;
		next.push("--extension", trimmed);
	}
	return next;
}
