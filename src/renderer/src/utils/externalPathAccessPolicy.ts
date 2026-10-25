/**
 * 项目外文件打开的分级策略（纯函数，无 React/Electron 依赖）。
 *
 * 背景：会话内文件链接此前对「项目外」一律硬拒——`resolveFileLinkPath` 传了
 * projectRoot 就越界即 null，点击只弹一句「不在当前项目内」（issue：AI 生成/操作在
 * 项目外的文件完全点不开，哪怕用户当次安全等级是「关闭」）。安全等级只管 pi 的工具
 * 调用，渲染层从未读过它，于是「关闭」也拦。
 *
 * 这里把「项目外」按用户当前安全等级分三档：allow（直接打开）/ ask（二次确认）/
 * deny（拒绝）。规则顺序与主进程 `src/main/security/policy.ts` 的 evaluatePathAction
 * 对齐（denyDirs 黑名单 > 敏感文件 > 目录边界），唯一差异是主进程对越界的工具调用是
 * deny，而用户在 UI 上主动点一个自己机器上的文件更适合降级成 ask（确认后可只读打开）。
 *
 * 目录与「在文件管理器里定位」是这条规则的例外：它们只会唤起系统文件管理器
 *（`shell.openPath` / `showItemInFolder`），不读内容、不执行，所以不弹确认（targetKind 分支）。
 *
 * 边界：本模块只决定「要不要问用户」，不是安全边界。真正的边界是主进程按 projectId
 * 的 scope 校验（`src/main/files/projectFileAccess.ts`）与安全门扩展对工具调用的拦截；
 * 项目外打开走无 scope 读取，只能靠这里收集用户意图。
 */

import { DEFAULT_SENSITIVE_PATH_PATTERNS, type SecurityConfig, type SecurityLevelConfig } from "../../../shared/types";
import { isFilePathInsideRoot, resolveFileLinkPath } from "./filePathLinks";

/** 判定原因（渲染层据此选文案；reason 只影响提示，不参与放行与否的推导） */
export type ExternalPathAccessReason =
	/** 安全总开关关闭：等同未启用安全管理，完全放行 */
	| "security-disabled"
	/** 等级不限制目录（off / standard）：直接打开 */
	| "unrestricted"
	/** 命中工作目录或等级的 customAllowDirs：直接打开 */
	| "allowed-dir"
	/** 命中等级 denyDirs 黑名单：拒绝（用户显式列为禁地，不提供二次确认） */
	| "deny-dir"
	/** 目标是目录：只会在系统文件管理器里打开（不读内容、不执行），不受项目边界与敏感模式限制 */
	| "directory"
	/** 在系统文件管理器里定位文件/目录：同样不读内容、不执行，因此也不受项目边界与敏感模式限制 */
	| "reveal"
	/** 等级开启敏感文件保护且命中模式：二次确认 */
	| "sensitive"
	/** 等级限定目录（strict / custom）且该路径不在允许范围内：二次确认 */
	| "outside-allowed-dirs"
	/** 安全配置读不到或等级缺失：二次确认（fail-safe：既不静默放行也不静默拒绝） */
	| "policy-unavailable";

export type ExternalPathAccessVerdict = {
	access: "allow" | "ask" | "deny";
	reason: ExternalPathAccessReason;
};

/**
 * 解析某会话实际生效的等级：会话级覆盖 → 全局默认 → 内置 standard → 配置里的第一个。
 * 与主进程 resolveLevelId/resolveLevel 同语义（配置损坏时保证仍能得到一个可用等级）。
 */
export function resolveSessionSecurityLevel(config: SecurityConfig, sessionId?: string): SecurityLevelConfig | null {
	const override = sessionId ? config.sessionOverrides?.[sessionId] : undefined;
	const levelId = override || config.defaultLevelId || "standard";
	const found = config.levels?.find((level) => level.id === levelId);
	if (found) return found;
	return config.levels?.find((level) => level.id === "standard") ?? config.levels?.[0] ?? null;
}

/** 敏感文件判定：模式是「文件名/目录段」正则，与主进程 matchesSensitivePath 同一份列表。 */
export function matchesSensitiveFilePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return DEFAULT_SENSITIVE_PATH_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern).test(normalized);
		} catch {
			// 配置里的非法正则不该让链接打开整条链路崩掉：视为未命中。
			return false;
		}
	});
}

/**
 * 打开动作的类别：决定它受哪些规则约束（严格来说，这是「风险量级」而不是「路径位置」）。
 * - file：把文件内容读进 PiDeck（编辑器 / 图片预览）——受项目边界与敏感模式约束；
 * - directory：唤起系统文件管理器打开目录——只开窗，不读内容、不执行，只是自标靶；
 * - reveal：在系统文件管理器里定位文件/目录——同上，风险量级与 directory 等价。
 */
export type ExternalPathTargetKind = "file" | "directory" | "reveal";

/**
 * 可执行 / 脚本类后缀：右键菜单的「用系统默认方式打开」走 shell.openPath，对这些后缀等于执行代码，
 * 所以项目外路径不提供该入口（方案 A 的既定降级：只给「文件管理器定位 / 复制路径」）。
 * 只用于菜单入口门禁，不影响左键打开的「读进 PiDeck」路径（那条根本不执行任何程序）。
 */
const EXECUTABLE_LIKE_EXTENSIONS = new Set(["exe", "msi", "msp", "bat", "cmd", "com", "scr", "cpl", "dll", "sys", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "jar", "lnk", "url", "reg", "sh", "bash", "zsh", "run", "app", "desktop"]);

/** 后缀判定（大小写无关）；无后缀、点开头的隐藏文件（.env / .gitignore）都不算。 */
export function isExecutableLikePath(filePath: string): boolean {
	const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return false;
	return EXECUTABLE_LIKE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** denyDirs / customAllowDirs 里的相对路径按会话基准目录展开（与主进程注释「相对路径视为相对工作目录」一致）。 */
function resolveConfigDir(dir: string, base: string | undefined): string {
	return resolveFileLinkPath(dir, base) ?? dir;
}

/** 配置目录列表命中判定（denyDirs / customAllowDirs 共用）：打开目录时也走同一语义。 */
function isInsideAnyDir(dirs: string[] | undefined, filePath: string, base: string | undefined): boolean {
	return (dirs ?? []).some((dir) => isFilePathInsideRoot(filePath, resolveConfigDir(dir, base)));
}

/** 策略判定 → UI 效果的唯一映射（决策与副作用分开，便于单测覆盖三条分支）。 */
export type ExternalPathOpenPlan =
	/** 直接打开（不弹框） */
	| { action: "open" }
	/** 二次确认（弹 ConfirmDialog，确认后才打开） */
	| { action: "confirm"; reason: ExternalPathAccessReason }
	/** 拒绝（只提示，绝不打开） */
	| { action: "blocked"; reason: ExternalPathAccessReason };

/** 把判定映成 UI 动作：allow → 直接开；ask → 确认；deny → 拒绝。 */
export function planExternalPathOpen(verdict: ExternalPathAccessVerdict): ExternalPathOpenPlan {
	if (verdict.access === "allow") return { action: "open" };
	if (verdict.access === "deny") return { action: "blocked", reason: verdict.reason };
	return { action: "confirm", reason: verdict.reason };
}

/**
 * 求值一个「项目外路径」的打开动作。
 *
 * 注意：调用方应当只在路径确实落在本项目之外时调用它——项目内路径仍由
 * `resolveFileLinkPath(..., projectRoot)` 的硬边界负责，本函数会放行
 * cwd/projectRoot 内的路径（reason=allowed-dir），用于兜住分屏/非会话区域等边界差异。
 *
 * targetKind 描述这次动作是「把内容读进 PiDeck」还是「只唤起系统文件管理器」：后者（目录 /
 * 文件管理器定位）不弹确认，只受 denyDirs 约束，详见下方分支注释。
 */
export function evaluateExternalPathAccess(input: { config: SecurityConfig | null; sessionId?: string; filePath: string; cwd?: string; projectRoot?: string; targetKind?: ExternalPathTargetKind }): ExternalPathAccessVerdict {
	const { config, sessionId, filePath, cwd, projectRoot } = input;
	const dirBase = cwd ?? projectRoot;
	const targetKind = input.targetKind ?? "file";

	// 非「读内容」动作放在最前：打开目录 / 在文件管理器里定位都只是唤起系统文件管理器，
	// 内容不进 PiDeck（不像文件那样被读进编辑器/预览），也没有可执行文件那种执行语义。
	// 因此敏感模式与目录边界（strict / custom）都不该为「打开或定位一个文件夹」弹确认框——用户
	// 本来就能在资源管理器里自由浏览，多问一次是纯摩擦。唯一保留的约束是用户显式列进 denyDirs
	// 的禁地；配置读不到时没有可依据的黑名单，直接放行。
	if (targetKind !== "file") {
		if (config?.enabled && isInsideAnyDir(resolveSessionSecurityLevel(config, sessionId)?.denyDirs, filePath, dirBase)) return { access: "deny", reason: "deny-dir" };
		return { access: "allow", reason: targetKind };
	}

	// 配置拉取失败时不猜：问用户（不静默放行绕过严格等级，也不静默拒绝回到老问题）。
	if (!config) return { access: "ask", reason: "policy-unavailable" };
	if (!config.enabled) return { access: "allow", reason: "security-disabled" };
	const level = resolveSessionSecurityLevel(config, sessionId);
	if (!level) return { access: "ask", reason: "policy-unavailable" };

	// 黑名单优先于一切 allow 判定（与主进程 evaluatePathAction 同序）
	if (isInsideAnyDir(level.denyDirs, filePath, dirBase)) return { access: "deny", reason: "deny-dir" };
	if (level.protectSensitivePaths && matchesSensitiveFilePath(filePath)) return { access: "ask", reason: "sensitive" };
	if (level.pathPolicy === "unrestricted") return { access: "allow", reason: "unrestricted" };

	// workspace / custom：工作目录本身始终算允许
	if (cwd && isFilePathInsideRoot(filePath, cwd)) return { access: "allow", reason: "allowed-dir" };
	if (projectRoot && isFilePathInsideRoot(filePath, projectRoot)) return { access: "allow", reason: "allowed-dir" };
	if (level.pathPolicy === "custom" && isInsideAnyDir(level.customAllowDirs, filePath, dirBase)) return { access: "allow", reason: "allowed-dir" };
	return { access: "ask", reason: "outside-allowed-dirs" };
}
