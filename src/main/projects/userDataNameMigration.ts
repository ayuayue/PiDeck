import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PACKAGED_USER_DATA_NAME, PACKAGED_USER_DATA_NAME_NEW } from "../portableUserData";
import type { UserDataNameMigrationNotice } from "../../shared/types/userDataMigration";
import { repairUserDataSessionHeaders } from "./userDataSessionHeaderMigration";
import { isMissingMigrationPath, isUserDataMigrationComplete, recordUserDataMigrationComplete } from "./userDataMigrationState";

/**
 * 正式包装版 userData 目录改名迁移（pi-desktop → PiDeck）。
 *
 * 背景：产品已更名 PiDeck，但默认数据/聊天目录仍落在历史名 `%APPDATA%\pi-desktop` 下，
 * 用户在聊天目录、侧栏项目路径里看到的是 "pi desktop" 而非 "PiDeck"。
 *
 * 设计约束：
 * - 在 app.ready 之前、`app.setPath("userData")` 之前同步执行（纯 node:fs，不依赖 Electron），
 *   返回值即本次启动应使用的 userData；根改名失败回退旧根，后续步骤失败继续新根，下次启动重试。
 * - 一次迁移完整闭环 = 目录改名 + 持久化绝对路径改写 + pi 会话 encoded 目录改名 + header.cwd 修复。
 *   全部成功后原子写完成记录；状态匹配则跳过扫描，缺失/损坏/版本不符则重新核验。
 *   子步骤均幂等；旧根已消失时仍补完剩余步骤，覆盖中途失败以及 #298 的 beta 存量用户。
 *   header 只换 cwd，历史消息逐字节保留，避免把迁移变成历史内容编辑。
 * - 只碰落在旧根内的路径：用户自定义到别处的聊天目录、同前缀的 pi-desktop-dev 均不受影响。
 * - 旧根仍存在（降级后两代并存）= 另一份数据仍在被使用：只补修新根自己的内容（如 beta 已改目录名
 *   但 header 仍指向已消失旧路径的会话），不改名、不合并、不删旧根，也不写完成记录。
 */

/** 历史正式包 userData 目录名（值收口在 portableUserData，改名只改那一处）。 */
export const LEGACY_PACKAGED_USER_DATA_NAME = PACKAGED_USER_DATA_NAME;
/** 新正式包 userData 目录名（与 productName 一致）。 */
export const NEW_PACKAGED_USER_DATA_NAME = PACKAGED_USER_DATA_NAME_NEW;

export type UserDataNameMigration =
	/** 未执行改名（新数据 / 旧根仍在而降级并存 / 已迁移过 / 便携版 / 显式目录） */
	| { kind: "skipped"; reason: "new-install" | "already-migrated" | "explicit-user-data-dir" | "collision"; userDataPath: string }
	/** 改名成功：目录已迁到 PiDeck，路径记账与会话目录已同步改写 */
	| { kind: "migrated"; oldPath: string; userDataPath: string; migratedSessionDirs: string[] }
	/** 目录改名或后续补修失败：使用仍存在的根，不记完成，下次启动重试。 */
	| { kind: "failed"; reason: string; userDataPath: string };

export type UserDataNameMigrationInput = {
	/** Electron `app.getPath("appData")` 的等价值（Roaming / Library/Application Support / ~/.config） */
	appDataDir: string;
	/** 用户主目录（`app.getPath("home")`），用于定位 ~/.pi/agent/sessions */
	homeDir: string;
	platform?: NodeJS.Platform;
	/** 便携版（PORTABLE_EXECUTABLE_DIR）或显式 --user-data-dir 时跳过改名 */
	portableOrExplicit?: boolean;
	/** 旧目录名：开发态/Dev 独立环境复用同一迁移闭环，默认历史正式版。 */
	legacyUserDataName?: string;
	/** 新目录解析结果：开发数据迁移与测试注入用。 */
	userDataPathOverride?: string;
};

/** 需要改写的持久化 JSON：内部以绝对路径记账，根改名后必须同步换前缀。 */
const REWRITTEN_FILES = ["settings.json", "automation.json", "chat-path.json", "projects.json", "dismissed-project-paths.json", "session-catalog.json", "session-catalog.json.bak", "session-summary-cache.json"];
/** drafts/<sessionId>/ 下可能内联粘贴文件绝对路径的草稿文件。 */
const REWRITTEN_DRAFT_FILE_NAMES = ["drafts.json", "drafts.md"];

function isCaseInsensitive(platform: NodeJS.Platform): boolean {
	return platform === "win32" || platform === "darwin";
}

/**
 * 把 cwd 编码成 pi 的 sessions 子目录名（逐字镜像 SessionScanner.safePathToken：
 * Windows 盘符路径整体小写 `C:\a\b` → `--c--a-b--`，其余路径不转小写 `/home/x` → `--home-x--`）。
 */
export function encodeSessionDirName(projectPath: string): string {
	const normalized = projectPath.replace(/\\/g, "/");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`.toLowerCase();
	return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/**
 * oldRoot 在 JSON 文本里可能出现的转义形态。除「整段统一形态」外，真实数据里同一条路径
 * 会混用转义层级（catalog 由多条写入链路产生：pi 上报、扫描器绝对路径、导入改写），
 * 所以还要覆盖每个分隔符独立取 `\` / `\\` / `\\/` 的组合形态。按长度降序，
 * 防止短形态先命中截断长形态。
 */
function rootFormPairs(oldRoot: string, newRoot: string): Array<[string, string]> {
	const oldIsWin = oldRoot.includes("\\");
	const pairs = new Map<string, string>();
	const add = (oldForm: string, newForm: string) => {
		if (!pairs.has(oldForm)) pairs.set(oldForm, newForm);
	};
	add(oldRoot, newRoot);
	add(oldRoot.replace(/\\/g, "/"), newRoot.replace(/\\/g, "/"));
	add(oldRoot.replace(/\\/g, "\\\\"), newRoot.replace(/\\/g, "\\\\"));
	add(oldRoot.replace(/\\/g, "\\\\\\\\"), newRoot.replace(/\\/g, "\\\\\\\\"));
	if (oldIsWin) {
		const oldParts = oldRoot.split("\\");
		const newParts = newRoot.split("\\");
		const separators = ["\\\\", "\\\\/", "\\"];
		const walk = (index: number, accOld: string, accNew: string) => {
			if (index === 0) {
				walk(1, oldParts[0], newParts[0]);
				return;
			}
			if (index === oldParts.length) {
				add(accOld, accNew);
				return;
			}
			for (const sep of separators) {
				walk(index + 1, accOld + sep + oldParts[index], accNew + sep + newParts[index]);
			}
		};
		walk(0, "", "");
	}
	return [...pairs.entries()].sort((a, b) => b[0].length - a[0].length);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把文本里所有「以 oldRoot 开头」的路径换成 newRoot 同形态值。
 * 边界用 lookahead（不消费字符）：后随路径分隔符（任意转义层级）、引号或结尾；
 * `pi-desktop-dev` 这类同前缀目录因下一字符是 `-` 而不命中。
 */
export function replaceRootInText(text: string, oldRoot: string, newRoot: string, caseInsensitive: boolean): string {
	let next = text;
	for (const [oldForm, newForm] of rootFormPairs(oldRoot, newRoot)) {
		const pattern = new RegExp(`${escapeRegExp(oldForm)}(?=(?:\\\\{1,4}|\\\\\\/|/|(?=")|$))`, caseInsensitive ? "gi" : "g");
		next = next.replace(pattern, newForm);
	}
	return next;
}

function rewriteFileInPlace(filePath: string, oldRoot: string, newRoot: string, encodedPairs: Array<[string, string]>, caseInsensitive: boolean): boolean {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		if (isMissingMigrationPath(error)) return false;
		throw error;
	}
	let next = replaceRootInText(raw, oldRoot, newRoot, caseInsensitive);
	// encoded token 全是连字符，与转义层级无关；磁盘实际目录名大小写混杂，
	// Windows 上整名不区分大小写，故大小写不敏感替换（filePath 原样 / originKey 小写都能命中）。
	for (const [oldName, newName] of encodedPairs) {
		if (oldName === newName) continue;
		next = next.replace(new RegExp(escapeRegExp(oldName), caseInsensitive ? "gi" : "g"), newName);
	}
	if (next === raw) return false;
	const stat = lstatSync(filePath);
	// 配置不能留下半截 JSON；不替换用户的符号链接，只对普通文件原子发布。
	if (!stat.isFile()) throw new Error("Cannot safely rewrite non-regular migration file");
	const temporary = `${filePath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, next, { encoding: "utf8", mode: stat.mode, flag: "wx", flush: true });
		renameSync(temporary, filePath);
	} finally {
		rmSync(temporary, { force: true });
	}
	return true;
}

/**
 * 迁移 ~/.pi/agent/sessions 下落在旧根内的 encoded 目录（默认聊天目录会话在其中）。
 *
 * 为什么不做「解码目录名再比对前缀」：编码把路径分隔符与段名里的连字符混成同一个 `-`，
 * 反解恒失真（`pi-desktop` 解成 `pi\desktop`），前缀永远对不上。改为正向匹配：
 * 枚举旧根真实子目录（深度/数量有界）→ 按磁盘命名规则生成候选编码名 → 大小写不敏感
 * 命中磁盘目录（历史命名混杂大小写，pi 归因比较时也整体转小写，故大小写不作为身份）。
 *
 * 返回 oldName→newName 映射：既用于目录改名，也用于把 catalog 里的 encoded token
 * （filePath 保留磁盘大小写、originKey 全小写正斜杠）同步换掉——会话 JSONL 的绝对路径
 * 是跨重启的会话身份，目录改名后不改写引用就会全部失联。
 *
 * allowRename=false（旧根仍在）时只补修「已改到新名下」的目录：旧根名下的目录属于并存的
 * 另一份数据，不属于本次修复范围，既不改名也不报错误。
 */
function migratePiSessionDirs(piSessionsRoot: string, legacyChildren: string[], oldRoot: string, newRoot: string, platform: NodeJS.Platform, failures: string[], allowRename: boolean): Map<string, string> {
	const renamed = new Map<string, string>();
	let entries: string[];
	try {
		entries = readdirSync(piSessionsRoot);
	} catch (error) {
		if (!isMissingMigrationPath(error)) failures.push("Cannot enumerate pi session directories");
		return renamed;
	}
	const caseInsensitive = isCaseInsensitive(platform);
	const nameKey = (name: string) => (caseInsensitive ? name.toLowerCase() : name);
	const byName = new Map(entries.map((entry) => [nameKey(entry), entry]));
	const separator = platform === "win32" ? "\\" : "/";
	const repair = (name: string) => {
		if (!repairUserDataSessionHeaders(join(piSessionsRoot, name), oldRoot, newRoot, platform)) failures.push(`Session headers incomplete: ${name}`);
	};
	const visited = new Set<string>();
	for (const childPath of legacyChildren) {
		const exact = encodeSessionDirName(childPath);
		// 登记路径与磁盘路径可能混用分隔符；同一 encoded 目录只能处理一次。
		const key = nameKey(exact);
		if (visited.has(key)) continue;
		visited.add(key);
		const newName = encodeSessionDirName(`${newRoot}${childPath.slice(oldRoot.length).replace(/^[\\/]/, separator)}`);
		const matched = byName.get(nameKey(exact));
		const existingNew = byName.get(nameKey(newName));
		if (!matched) {
			// 中断后目录已改名，仍需补修 header，并重建映射以修正尚未写入的 catalog。
			if (existingNew) {
				repair(existingNew);
				renamed.set(exact, existingNew);
			}
			continue;
		}
		if (nameKey(newName) !== nameKey(matched)) {
			if (!allowRename) {
				// 并存的旧根目录保留原样；已存在于新名下的目录仍要补修 header（只改了目录名的情况）。
				if (existingNew && nameKey(existingNew) !== nameKey(matched)) {
					repair(existingNew);
					renamed.set(matched, existingNew);
				}
				continue;
			}
			try {
				const target = join(piSessionsRoot, newName);
				// 两份历史不可按文件名猜测合并；保留两边与旧引用，且绝不能记完成。
				if (safeIsDirectory(target)) {
					failures.push(`Session directory collision: ${matched}`);
					continue;
				}
				renameSync(join(piSessionsRoot, matched), target);
			} catch {
				failures.push(`Cannot rename session directory: ${matched}`);
				continue;
			}
		}
		const targetName = nameKey(newName) === nameKey(matched) ? matched : newName;
		repair(targetName);
		renamed.set(matched, targetName);
	}
	return renamed;
}

/** 旧根一层子目录（有界枚举，userData 根下直接子目录数量有限）。 */
function listChildDirs(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name));
	} catch (error) {
		if (isMissingMigrationPath(error)) return [];
		throw error;
	}
}

/**
 * 从 chat-path.json 读出登记的聊天目录（落在旧根内才返回）。
 * 兜底场景：用户删过默认 chat-workspace 但历史会话目录还在 ~/.pi 下——
 * 磁盘枚举命中不了，会让 catalog 里的 encoded token 永远改不掉。
 * 必须在文件改写前调用：转义层级混杂的值一旦被换根就可能变成混合形态，无法再解码。
 */
function readRecordedChatDir(chatPathFile: string, oldRoot: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(chatPathFile, "utf8");
	} catch (error) {
		if (isMissingMigrationPath(error)) return null;
		throw error;
	}
	const match = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (!match) return null;
	// 逐层去转义（值可能被多层写入链路重复转义），直到不含 `\\` 为止
	let decoded = match[1];
	for (let level = 0; level < 4 && decoded.includes("\\\\"); level++) {
		decoded = decoded.split("\\\\").join("\\");
	}
	decoded = decoded.split('\\"').join('"');
	const normalized = decoded.replace(/\\/g, "/").toLowerCase();
	const root = oldRoot.replace(/\\/g, "/").toLowerCase();
	return normalized === root || normalized.startsWith(`${root}/`) ? decoded : null;
}

/** 启动装配入口：只有全链路核验成功才能记完成，之后启动跳过配置/会话扫描。 */
export function runUserDataNameMigration(input: UserDataNameMigrationInput): UserDataNameMigration {
	const platform = input.platform ?? process.platform;
	const oldRoot = resolve(join(input.appDataDir, input.legacyUserDataName ?? LEGACY_PACKAGED_USER_DATA_NAME));
	const newRoot = resolve(input.userDataPathOverride ?? join(input.appDataDir, PACKAGED_USER_DATA_NAME_NEW));
	const context = { oldRoot, newRoot, sessionsRoot: resolve(join(input.homeDir, ".pi", "agent", "sessions")), platform };
	if (input.portableOrExplicit) return { kind: "skipped", reason: "explicit-user-data-dir", userDataPath: newRoot };
	let userDataPath = oldRoot;
	try {
		const oldExists = safeIsDirectory(oldRoot);
		const newExists = safeIsDirectory(newRoot);
		if (!oldExists && !newExists) return { kind: "skipped", reason: "new-install", userDataPath: newRoot };
		// 两代目录并存：旧根那份数据可能仍被旧版本使用，本次只补修新根自己，绝不合并或删除。
		const legacyPresent = oldExists && newExists;
		const renamedThisRun = oldExists && !newExists;
		if (!oldExists && isUserDataMigrationComplete(context)) return { kind: "skipped", reason: "already-migrated", userDataPath: newRoot };
		if (renamedThisRun) {
			mkdirSync(dirname(newRoot), { recursive: true });
			renameSync(oldRoot, newRoot);
		}
		userDataPath = newRoot;

		const failures: string[] = [];
		const caseInsensitive = isCaseInsensitive(platform);
		const legacyChildren = [oldRoot, ...listChildDirs(newRoot).map((child) => `${oldRoot}${child.slice(newRoot.length)}`)];
		const chatPathFile = join(newRoot, "chat-path.json");
		const recordedOld = readRecordedChatDir(chatPathFile, oldRoot);
		const recordedNew = readRecordedChatDir(chatPathFile, newRoot);
		const recordedChatDir = recordedOld ?? (recordedNew ? `${oldRoot}${recordedNew.slice(newRoot.length)}` : null);
		if (recordedChatDir && !legacyChildren.includes(recordedChatDir)) legacyChildren.push(recordedChatDir);
		const migratedSessionDirs = migratePiSessionDirs(context.sessionsRoot, legacyChildren, oldRoot, newRoot, platform, failures, !legacyPresent);
		const encodedPairs = [...migratedSessionDirs.entries()];
		const rewrite = (path: string) => {
			try {
				rewriteFileInPlace(path, oldRoot, newRoot, encodedPairs, caseInsensitive);
			} catch {
				failures.push(`Cannot rewrite persisted path: ${path}`);
			}
		};
		for (const fileName of REWRITTEN_FILES) rewrite(join(newRoot, fileName));
		for (const directory of ["feishu", "pi-desktop"]) {
			try {
				for (const entry of readdirSync(join(newRoot, directory))) {
					const path = join(newRoot, directory, entry);
					if (entry.startsWith("feishu") && entry.endsWith(".json") && safeIsFile(path)) rewrite(path);
				}
			} catch (error) {
				if (!isMissingMigrationPath(error)) failures.push(`Cannot inspect configuration directory: ${directory}`);
			}
		}
		try {
			const draftsRoot = join(newRoot, "drafts");
			for (const dir of readdirSync(draftsRoot)) {
				for (const fileName of REWRITTEN_DRAFT_FILE_NAMES) {
					const candidate = join(draftsRoot, dir, fileName);
					if (safeIsFile(candidate)) rewrite(candidate);
				}
			}
		} catch (error) {
			if (!isMissingMigrationPath(error)) failures.push("Cannot inspect drafts");
		}
		if (failures.length) return { kind: "failed", reason: failures.join("; "), userDataPath: newRoot };
		// 旧根仍在时不能记完成：那份数据还没处理，下次启动必须继续核验。
		if (legacyPresent) return { kind: "skipped", reason: "collision", userDataPath: newRoot };
		recordUserDataMigrationComplete(context);
		// 已改根的存量补修不再重复展示整目录迁移提示。
		return renamedThisRun ? { kind: "migrated", oldPath: oldRoot, userDataPath: newRoot, migratedSessionDirs: [...migratedSessionDirs.keys()] } : { kind: "skipped", reason: "already-migrated", userDataPath: newRoot };
	} catch (error) {
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error), userDataPath };
	}
}

function safeIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch (error) {
		if (isMissingMigrationPath(error)) return false;
		throw error;
	}
}

function safeIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch (error) {
		if (isMissingMigrationPath(error)) return false;
		throw error;
	}
}

// ── 一次性迁移提示 ─────────────────────────────────────────────
// 迁移在 setPath 之前同步完成，其时窗口/日志器都不存在；结果暂存于此，
// 渲染层首挂载经 IPC 消费一次（toast「历史数据已迁移」），之后永不再报。

let pendingNotice: UserDataNameMigrationNotice | null = null;

/** 由迁移结果生成待领提示；非 migrated 结果清空旧值（幂等，可每次启动调用）。 */
export function recordUserDataNameMigrationNotice(result: UserDataNameMigration): void {
	pendingNotice =
		result.kind === "migrated"
			? {
					oldPath: result.oldPath,
					newPath: result.userDataPath,
					migratedSessionDirCount: result.migratedSessionDirs.length,
				}
			: null;
}

/** 消费式领取迁移提示：首次返回后清空。 */
export function consumeUserDataNameMigrationNotice(): UserDataNameMigrationNotice | null {
	const notice = pendingNotice;
	pendingNotice = null;
	return notice;
}
