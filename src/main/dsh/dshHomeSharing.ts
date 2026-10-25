/**
 * DSH_HOME 共享 / 并发冲突判定（纯函数，可单测）。
 *
 * ── 背景（issue #189 问题 1）────────────────────────────────────────────
 * `resolveDshHomeDir` 默认使用用户真实 `~/.dsh`（与 dsh CLI 共用 profiles /
 * settings.yaml / 插件状态文件）。DSH 官方硬约束是「同一 DSH_HOME 只允许一个
 * host」：两个实例并存时后写者覆盖先写者（实测：CLI web UI 选的主题数分钟内
 * 被前台 PiDeck 实例写回默认）。
 *
 * PiDeck 无法阻止外部 dsh 进程（dsh CLI 不遵守 PiDeck 的锁文件），因此这里
 * 不做「拦截」，只做两件可做的事：
 * 1. 把「当前正在共用默认 home」这个事实透出到配置页，给出官方隔离手段
 *    （命令行侧设置 DSH_HOME）；
 * 2. 把锁文件里「另一个存活 DSH host 正持有同一目录」的 pid 透出，
 *    让双 PiDeck 实例这类可检测冲突不再只落在应用日志里。
 *
 * 纯函数边界：homeDir / selfPid / isAlive 全部注入，模块自身不读环境、
 * 不访问文件系统、不调用 process.kill——判定规则可离开 Electron 单测。
 * ────────────────────────────────────────────────────────────────────
 */

/** 默认共享 home 的目录名（与 dsh CLI 的 `$DSH_HOME` 默认值同源）。 */
export const DEFAULT_DSH_HOME_DIR_NAME = ".dsh";

// 跨进程形状定义在 shared（preload/渲染层要引用同一结构，禁止各自重复定义）。
export type { DshHomeSharingState } from "../../shared/types/dshHome";
import type { DshHomeSharingState } from "../../shared/types/dshHome";

/**
 * 路径归一化后比较（Windows 大小写不敏感 + 统一分隔符 + 去尾部分隔符）。
 * 用于判定「当前 home 是否就是默认 ~/.dsh」，不用于文件系统寻址。
 */
export function normalizeDshHomePath(value: string): string {
	const unified = value
		.trim()
		.replace(/[\\/]+/g, "/")
		.replace(/\/+$/, "");
	return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** 当前 home 是否就是默认 `~/.dsh`（与 dsh CLI 共用同一份配置/会话）。 */
export function isCliSharedHome(dshHome: string, homeDir: string): boolean {
	if (!dshHome.trim() || !homeDir.trim()) return false;
	return normalizeDshHomePath(dshHome) === normalizeDshHomePath(`${homeDir.replace(/[\\/]+$/, "")}/${DEFAULT_DSH_HOME_DIR_NAME}`);
}

/**
 * 解析 PiDeck 的 DSH_HOME 共享状态：
 * - override 非空 = 用户已显式指定目录（视为已隔离，不再提示共享）；
 * - 否则按 `resolveDshHomeDir` 的默认规则与 `~/.dsh` 比对。
 */
export function resolveDshHomeSharing(input: { dshHome: string; override?: string; homeDir: string }): DshHomeSharingState {
	const usingOverride = Boolean(input.override?.trim());
	return {
		usingOverride,
		sharesCliHome: !usingOverride && isCliSharedHome(input.dshHome, input.homeDir),
	};
}

/**
 * 从锁文件内容取「另一个存活 DSH host」的 pid。
 *
 * 判定规则（与 DshHost.acquireHostLock 现行为一致）：
 * - 内容非法 / 无 pid 字段 → undefined（锁损坏不该报冲突）；
 * - pid 等于本进程 → undefined（自己的锁，重启前的残留）；
 * - pid 不在存活集 → undefined（陈旧锁，正常接管）；
 * - 否则返回该 pid（真有另一个实例在跑）。
 *
 * @param isAlive 进程存活探测，由调用方注入（DshHost 传 kill(pid,0) 实现）。
 */
export function externalHostHolderPid(input: { lockRaw?: string; selfPid: number; isAlive: (pid: number) => boolean }): number | undefined {
	const raw = input.lockRaw?.trim();
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const pid = (parsed as { pid?: unknown }).pid;
	if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return undefined;
	if (pid === input.selfPid) return undefined;
	return input.isAlive(pid) ? pid : undefined;
}
