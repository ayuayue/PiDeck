import { app, dialog } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project } from "../../shared/types";
import { projectLocatorFromLegacy } from "../../shared/locationAdapters";
import { normalizeSelectedWslProjectPath, parseWslUncPath, WslPathError, type WslEnvironment } from "../wsl/WslPaths";
import { getAppLogger } from "../logging/sharedLogger";
import { assertHostRebindRecordIds, canonicalHostLocatorJson, type HostRebindRecordPatch, type HostRebindRecordResult, type HostRebindRecordSnapshot, type HostRebindStorePort } from "../remote/HostRebindJournal";
import { isEphemeralProjectPath, projectPathKey, sanitizeProjectDisplayName } from "./projectPathPolicy";
import { loadProjectStore, writeProjectStoreSnapshot } from "./projectStorePersistence";

const CHAT_PROJECT_ID = "builtin-chat";
const CHAT_PROJECT_NAME = "Chat";

/** 端口边界只允许稳定码（设计 §4.4）：与 projectStoreCodec.ts:81 的 ssh 读拒绝同码。 */
const PROJECT_STORE_NEEDS_REPAIR = "PROJECT_STORE_NEEDS_REPAIR";
const PROJECT_STORE_REMOTE_UNSUPPORTED = "PROJECT_STORE_REMOTE_UNSUPPORTED";
const REBIND_UNKNOWN_OUTCOME = "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME";

class ProjectStoreNeedsRepairError extends Error {
	readonly code = PROJECT_STORE_NEEDS_REPAIR;

	constructor(message: string) {
		super(message);
		this.name = "ProjectStoreNeedsRepairError";
	}
}

function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}

export class ProjectStore implements HostRebindStorePort {
	/** DSH 外部会话兑底项目稳定 id（无 cwd/未匹配目录的会话归属；见 ensureExternalSessionsProject）。 */
	private static readonly EXTERNAL_PROJECT_ID = "builtin-external";
	/**
	 * 引用能力声明（设计 §4.4 / Q6）：`projects.json` 读到 ssh locator 时 `readV2Project` 直接拒绝
	 * （projectStoreCodec.ts:81），`Project` 类型也没有 locator 字段 ⇒ 本 store 结构上不可能持有 host
	 * 引用，注册表据此整源跳过。Phase 3 放开 `PROJECT_STORE_REMOTE_UNSUPPORTED` 时这里必须一起改回 true。
	 */
	readonly canHoldHostReferences = false;
	private readonly filePath = join(app.getPath("userData"), "projects.json");
	private readonly chatPathFile = join(app.getPath("userData"), "chat-path.json");
	/** 用户从侧栏移除过的目录：启动自动导入不得再按会话 cwd 把它们加回。 */
	private readonly dismissedFilePath = join(app.getPath("userData"), "dismissed-project-paths.json");
	// 聊天工作区目录：默认在 userData 下，用户可在侧栏聊天项目设置中改为任意目录并持久化。
	private chatProjectPath = join(app.getPath("userData"), "chat-workspace");
	private projects: Project[] = [];
	private dismissedPaths: string[] = [];
	private revision = 0;
	private writeQueue: Promise<void> = Promise.resolve();
	private skipNextBackup = false;
	private needsRepair = false;
	private repairError: ProjectStoreNeedsRepairError | null = null;

	constructor(private readonly chooseProjectTitle: () => string = () => "Choose project folder") {}

	async load() {
		let persisted: Awaited<ReturnType<typeof loadProjectStore>>;
		try {
			persisted = await loadProjectStore(this.filePath);
		} catch (error) {
			this.needsRepair = true;
			this.repairError = new ProjectStoreNeedsRepairError(errorMessage(error));
			this.projects = [];
			void getAppLogger()?.error("project-store", "Project store recovery is required", {
				cause: this.repairError.message,
			});
			throw error;
		}
		this.needsRepair = false;
		this.repairError = null;
		this.projects = persisted.projects;
		this.revision = persisted.revision;
		this.skipNextBackup = persisted.skipNextBackup;
		// 先读取用户自定义的聊天目录（若存在），再据此修正内置聊天项目路径。
		await this.loadChatProjectPath();
		await this.loadDismissedPaths();
		const chatChanged = this.ensureChatProject();
		const orderChanged = this.ensureSortOrder();
		const ephemeralRemoved = this.dropEphemeralProjects();
		const changed = chatChanged || orderChanged || ephemeralRemoved.length > 0 || persisted.needsRewrite;
		await mkdir(this.chatProjectPath, { recursive: true });
		if (changed) await this.save();
		if (ephemeralRemoved.length > 0) await this.saveDismissedPaths();
		return this.list();
	}

	list() {
		this.assertReadable();
		return [...this.projects].sort((a, b) => Number(this.isChatProject(b)) - Number(this.isChatProject(a)) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || this.projectSortOrder(a) - this.projectSortOrder(b) || b.lastOpenedAt - a.lastOpenedAt);
	}

	get(id: string) {
		this.assertReadable();
		return this.projects.find((project) => project.id === id);
	}

	getChatProjectPath() {
		return this.chatProjectPath;
	}

	/**
	 * 设置内置聊天项目的会话目录并持久化。
	 * 更新内存中的聊天项目路径、写入 chat-path.json，并确保目标目录存在。
	 * 返回更新后的聊天项目（便于主进程向渲染端广播 projects:changed）。
	 */
	async setChatProjectPath(path: string) {
		this.assertWritable();
		const normalized = this.normalizeProjectPath(path);
		// 边界保护：聊天目录不允许指向已注册的普通项目目录（issue #149）。否则聊天项目与
		// 该项目同路径并存，重启后 ensureChatProject 曾把该项目整条吸收，且「添加项目」选
		// 同一目录只会返回 builtin-chat，项目区永远不再出现新项目。
		const occupied = this.projects.find((project) => !this.isChatProject(project) && this.sameProjectPath(project.path, normalized));
		if (occupied) {
			throw new Error("CHAT_PATH_OVERLAPS_PROJECT");
		}
		this.chatProjectPath = normalized;
		await writeFile(this.chatPathFile, JSON.stringify({ path: normalized }), "utf8");
		const chat = this.projects.find((project) => this.isChatProject(project) || project.id === CHAT_PROJECT_ID);
		if (chat) chat.path = normalized;
		await mkdir(normalized, { recursive: true });
		await this.save();
		return chat ?? null;
	}

	private rememberDismissedPath(path: string) {
		const key = projectPathKey(path);
		if (!key) return;
		if (this.dismissedPaths.some((item) => projectPathKey(item) === key)) return;
		this.dismissedPaths.push(path);
	}

	private forgetDismissedPath(path: string) {
		const key = projectPathKey(path);
		this.dismissedPaths = this.dismissedPaths.filter((item) => projectPathKey(item) !== key);
	}

	private async loadDismissedPaths() {
		try {
			const raw = await readFile(this.dismissedFilePath, "utf8");
			const parsed = JSON.parse(raw) as { paths?: unknown };
			this.dismissedPaths = Array.isArray(parsed.paths) ? parsed.paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
		} catch {
			this.dismissedPaths = [];
		}
	}

	private async saveDismissedPaths() {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(this.dismissedFilePath, JSON.stringify({ paths: this.dismissedPaths }, null, 2), "utf8");
	}

	/** 读取用户自定义的聊天目录；不存在或解析失败时回退到默认 chat-workspace。 */
	private async loadChatProjectPath() {
		try {
			const raw = await readFile(this.chatPathFile, "utf8");
			const parsed = JSON.parse(raw) as { path?: string };
			if (parsed.path) this.chatProjectPath = this.normalizeProjectPath(parsed.path);
		} catch {
			// 无自定义路径时保持默认 userData/chat-workspace
		}
	}

	async chooseAndAdd(environment?: "windows" | "wsl", wslEnvironment?: WslEnvironment | null) {
		this.assertWritable();
		if (environment === "wsl" && !wslEnvironment) {
			throw new WslPathError("INVALID_WSL_PATH", "The active WSL environment is unavailable.");
		}
		const result = await dialog.showOpenDialog({
			title: this.chooseProjectTitle(),
			...(environment === "wsl" ? { defaultPath: wslEnvironment!.windowsHome } : {}),
			properties: ["openDirectory"],
		});

		if (result.canceled || result.filePaths.length === 0) return null;
		let projectPath = result.filePaths[0];

		// WSL 盘符项目沿用 /mnt 存储格式；WSL 内部项目保留为可供 Windows 主进程访问的规范 UNC。
		if (environment === "wsl") {
			projectPath = normalizeSelectedWslProjectPath(projectPath, wslEnvironment!);
		}

		return this.add(projectPath, undefined, environment);
	}

	/** 添加项目，可指定所属环境（缺省 windows） */
	async add(path: string, worktreeParentId?: string, environment?: "windows" | "wsl") {
		this.assertWritable();
		const normalizedPath = this.normalizeProjectPath(path);
		// 内置聊天项目不参与「同路径即已有项目」匹配（issue #149）：用户挑选的目录即使与
		// 聊天目录相同，也必须创建真正的项目记录——否则 add() 永远返回 builtin-chat，
		// 项目区不再出现新项目，侧栏只剩聊天区。
		const existing = this.projects.find((project) => !this.isChatProject(project) && this.sameProjectPath(project.path, normalizedPath));
		if (existing) {
			existing.path = normalizedPath;
			existing.lastOpenedAt = Date.now();
			// 外部已有 worktree 可能曾经作为顶级项目加入；开启工作区后需要补上父子关系。
			if (worktreeParentId && existing.id !== worktreeParentId) {
				existing.worktreeParentId = worktreeParentId;
				existing.pinned = false;
			}
			this.forgetDismissedPath(normalizedPath);
			await this.save();
			await this.saveDismissedPaths();
			return existing;
		}

		const project: Project = {
			id: randomUUID(),
			name: basename(normalizedPath) || normalizedPath,
			path: normalizedPath,
			lastOpenedAt: Date.now(),
			sortOrder: this.nextSortOrder(),
			// 兼容旧数据：environment 缺省视为 windows
			environment: environment || "windows",
			...(worktreeParentId ? { worktreeParentId } : {}),
		};

		this.projects.push(project);
		// 用户再次手动添加同一目录：从「已移除」名单拿掉，允许以后自动导入。
		this.forgetDismissedPath(normalizedPath);
		await this.save();
		await this.saveDismissedPaths();
		return project;
	}

	async remove(id: string) {
		this.assertWritable();
		const removed = this.projects.filter((project) => project.id === id || project.worktreeParentId === id);
		// 删除父项目时同步移除子项目记录，避免留下不可见的孤儿 worktree 项目。
		this.projects = this.projects.filter((project) => (project.id !== id && project.worktreeParentId !== id) || this.isChatProject(project));
		for (const project of removed) {
			if (!this.isChatProject(project) && project.path) {
				this.rememberDismissedPath(project.path);
			}
		}
		await this.save();
		await this.saveDismissedPaths();
	}

	/**
	 * 重命名项目显示名（仅改侧栏/标题等展示 label，不修改磁盘目录）。
	 * 拒绝两类项目：
	 * - 内置聊天项目：name 由 ensureChatProject 固定为 "Chat"，重命名会被下次加载覆盖；
	 * - worktree 子项目：其 name 承载 git 分支名（WorktreeTree 展示 / 删除 worktree 时按 name 定位分支），
	 *   改名会导致分支关联错乱。
	 * 返回更新后的项目；id 不存在返回 null。
	 */
	async rename(id: string, name: string): Promise<Project | null> {
		this.assertWritable();
		const project = this.get(id);
		if (!project) return null;
		if (this.isChatProject(project) || project.worktreeParentId) {
			throw new Error("PROJECT_RENAME_NOT_ALLOWED");
		}
		project.name = sanitizeProjectDisplayName(name);
		await this.save();
		return project;
	}

	/** 用户已从侧栏移除的目录（供启动自动导入判断是否按 cwd 重建项目）。 */
	listDismissedPaths(): string[] {
		return [...this.dismissedPaths];
	}

	/**
	 * 丢掉 e2e/临时隔离目录项目（如 %TEMP%/pideck-mockpi-*）。
	 * 这些路径本就不该进入开发者本机侧栏；启动时清掉并记入已移除名单，
	 * 避免 DSH 自动导入按 cwd 再注册。返回被删项目 id。
	 */
	dropEphemeralProjects(): string[] {
		this.assertWritable();
		const removedIds: string[] = [];
		const kept: Project[] = [];
		for (const project of this.projects) {
			if (!this.isChatProject(project) && project.path && isEphemeralProjectPath(project.path)) {
				removedIds.push(project.id);
				this.rememberDismissedPath(project.path);
				continue;
			}
			kept.push(project);
		}
		if (removedIds.length === 0) return [];
		this.projects = kept;
		return removedIds;
	}

	async reorder(projectIds: string[]) {
		this.assertWritable();
		const movableProjectIds = projectIds.filter((id) => id !== CHAT_PROJECT_ID);
		const orderById = new Map(movableProjectIds.map((id, index) => [id, index]));
		const tailStart = movableProjectIds.length;
		const currentOrder = this.list()
			.filter((project) => !this.isChatProject(project))
			.map((project) => project.id);

		this.projects.forEach((project) => {
			if (this.isChatProject(project)) {
				project.sortOrder = -1;
				return;
			}
			const explicitOrder = orderById.get(project.id);
			project.sortOrder = explicitOrder ?? tailStart + currentOrder.indexOf(project.id);
		});

		await this.save();
		return this.list();
	}

	private ensureChatProject() {
		// 只按身份定位聊天项目（kind/id），不按路径匹配（issue #149）：聊天目录被设为某项目
		// 目录后，路径相同的普通项目会被误判为聊天项目，整条覆盖（id/name/kind 被改写）并
		// 从列表中删除——用户的项目区从此只剩聊天区，重启后仍被持久化。
		const existing = this.projects.find((project) => this.isChatProject(project) || project.id === CHAT_PROJECT_ID);
		const nextChatProject: Project = {
			id: CHAT_PROJECT_ID,
			name: CHAT_PROJECT_NAME,
			path: this.chatProjectPath,
			lastOpenedAt: existing?.lastOpenedAt ?? Date.now(),
			pinned: true,
			sortOrder: -1,
			kind: "chat",
		};

		if (!existing) {
			this.projects.unshift(nextChatProject);
			return true;
		}

		const previousLength = this.projects.length;
		const changed = existing.id !== nextChatProject.id || existing.name !== nextChatProject.name || existing.path !== nextChatProject.path || existing.kind !== nextChatProject.kind || existing.pinned !== nextChatProject.pinned || existing.sortOrder !== nextChatProject.sortOrder;
		Object.assign(existing, nextChatProject);
		// 仅去重多余的聊天项目记录（kind/id 命中），普通项目即使路径与聊天目录相同也保留。
		this.projects = this.projects.filter((project, index) => index === this.projects.indexOf(existing) || (!this.isChatProject(project) && project.id !== CHAT_PROJECT_ID));
		return changed || this.projects.length !== previousLength;
	}

	private ensureSortOrder() {
		const needsOrder = this.projects.some((project) => typeof project.sortOrder !== "number" || Number.isNaN(project.sortOrder));
		if (!needsOrder) return false;

		// 首次升级旧数据时保留原来的“置顶优先 + 最近打开”顺序，之后由用户拖拽顺序接管。
		[...this.projects]
			.filter((project) => !this.isChatProject(project))
			.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastOpenedAt - a.lastOpenedAt)
			.forEach((project, index) => {
				project.sortOrder = index;
			});
		const chatProject = this.projects.find((project) => this.isChatProject(project));
		if (chatProject) chatProject.sortOrder = -1;
		return true;
	}

	private nextSortOrder() {
		if (this.projects.length === 0) return 0;
		return Math.max(...this.projects.map((project) => this.projectSortOrder(project))) + 1;
	}

	private projectSortOrder(project: Project) {
		return typeof project.sortOrder === "number" && !Number.isNaN(project.sortOrder) ? project.sortOrder : Number.MAX_SAFE_INTEGER;
	}

	/** 仅返回顶级项目（非 worktree 子项目），用于侧栏主列表 */
	listRoot() {
		return this.list().filter((p) => !p.worktreeParentId);
	}

	/** 获取指定父项目的所有 worktree 子项目 */
	listWorktreeChildren(parentId: string) {
		return this.list().filter((p) => p.worktreeParentId === parentId);
	}

	/** 按路径查找项目；Windows 上忽略大小写和分隔符差异。 */
	findByPath(path: string) {
		this.assertReadable();
		const normalizedPath = this.normalizeProjectPath(path);
		return this.projects.find((project) => this.sameProjectPath(project.path, normalizedPath)) ?? null;
	}

	/**
	 * DSH 外部会话兑底项目（稳定 id，幂等）：给「没有 cwd / cwd 未注册项目」的
	 * 外部会话一个确定归属，而不是随机挂到第一个非 chat 项目（用户不可预期）。
	 * 目录落在 userData/external-sessions（随应用数据存在，不会被标记 missing）。
	 */
	async ensureExternalSessionsProject(name: string): Promise<Project> {
		this.assertWritable();
		const existing = this.projects.find((project) => project.id === ProjectStore.EXTERNAL_PROJECT_ID);
		if (existing) {
			// 语言切换等场景下名称可能变化：就地更新，保持 id 稳定（catalog 引用不失效）。
			const changed = existing.name !== name || existing.pinned !== true;
			existing.name = name;
			existing.pinned = true;
			if (changed) await this.save();
			return existing;
		}
		const project: Project = {
			id: ProjectStore.EXTERNAL_PROJECT_ID,
			name,
			path: join(app.getPath("userData"), "external-sessions"),
			lastOpenedAt: Date.now(),
			pinned: true,
			sortOrder: this.nextSortOrder(),
		};
		await mkdir(project.path, { recursive: true });
		this.projects.push(project);
		await this.save();
		return project;
	}

	async toggleWorktreeEnabled(id: string) {
		this.assertWritable();
		const project = this.get(id);
		if (!project) return null;
		project.worktreeEnabled = !project.worktreeEnabled;
		// 关闭工作区模式时，清除已注册的 worktree 子项目记录，避免侧栏不再展示它们后
		// 仍残留在 projects.json 中成为孤儿数据。仅移除项目记录，不删除物理 worktree 目录。
		if (!project.worktreeEnabled) {
			this.clearWorktreeChildren(id);
		}
		await this.save();
		return project;
	}

	/** 移除指定父项目下的所有 worktree 子项目记录（不删除物理目录） */
	clearWorktreeChildren(parentId: string) {
		this.assertWritable();
		this.projects = this.projects.filter((project) => project.worktreeParentId !== parentId || this.isChatProject(project));
	}

	/**
	 * Host-rebind read port（设计 §4.4）：逐条返回记录的当前 locator（规范 JSON）；记录不存在时按契约
	 * 返回缺省 locator（收敛侧据此判 `REMOTE_HOST_REBIND_RECORD_MISSING`，INV-6：不复活）。
	 *
	 * 本 store 只能持有 local locator，所以这里**如实**返回记录的 local locator（与落盘形态同源：
	 * `encodeProjectStoreSnapshot` 用同一个 `projectLocatorFromLegacy` 派生），不编造 ssh 支持。
	 * 计划里只要出现 ssh 的 before/after，逐记录比对必然不相等 ⇒ 收敛侧 STALE_PLAN 停事务，不迁移。
	 */
	async readHostRecordLocators(recordIds: readonly string[]): Promise<readonly HostRebindRecordSnapshot[]> {
		this.assertHostRebindUsable();
		assertHostRebindRecordIds(recordIds);
		// 同步走一趟内存快照：整批读是同一个一致性视图（本函数内没有 await）。
		return recordIds.map((recordId) => {
			const project = this.projects.find((candidate) => candidate.id === recordId);
			if (!project) return { recordId };
			return { recordId, locator: canonicalHostLocatorJson(projectLocatorFromLegacy({ path: project.path, environment: project.environment, wslDistro: project.wslDistro })) };
		});
	}

	/**
	 * Host-rebind write port（设计 §4.4 / Q6）：本 store 装不下 ssh locator，因此没有任何补丁能在这里
	 * 成立 —— 一律拒绝，且**不经过 `save()`**、不碰磁盘。这是诚实的 fail closed，不是"还没实现"：
	 * 放开它必须同时放开 `projectStoreCodec.ts:81` 并补 SSH 项目的 containment 校验（计划 §12 Phase 3 门禁）。
	 */
	async applyHostRebind(_txId: string, patches: readonly HostRebindRecordPatch[]): Promise<readonly HostRebindRecordResult[]> {
		this.assertHostRebindUsable();
		if (!Array.isArray(patches)) throw new Error(REBIND_UNKNOWN_OUTCOME);
		if (patches.length === 0) return [];
		throw new Error(PROJECT_STORE_REMOTE_UNSUPPORTED);
	}

	/** 端口边界只允许稳定码：needs-repair 时读写都必须 fail closed，不能答成"没有记录"或"没有补丁"。 */
	private assertHostRebindUsable(): void {
		if (this.needsRepair) throw new Error(PROJECT_STORE_NEEDS_REPAIR);
	}

	private assertReadable() {
		if (this.needsRepair) throw this.repairError ?? new ProjectStoreNeedsRepairError(PROJECT_STORE_NEEDS_REPAIR);
	}

	private assertWritable() {
		this.assertReadable();
	}

	private isChatProject(project: Project) {
		return project.kind === "chat" || project.id === CHAT_PROJECT_ID;
	}

	private normalizeProjectPath(path: string) {
		// WSL Linux 路径（/mnt/d/xxx、/home/user/...）不能走 Windows path.resolve/normalize，
		// 否则 /mnt/d/xxx 会被解析为 D:\\mnt\\d\\xxx。仅去除尾部斜杠。
		if (process.platform === "win32" && path.startsWith("/")) {
			return path.replace(/\/+$/, "");
		}
		return normalize(resolve(path));
	}

	private sameProjectPath(a: string, b: string) {
		const leftWsl = parseWslUncPath(a);
		const rightWsl = parseWslUncPath(b);
		if (leftWsl && rightWsl) {
			return leftWsl.distro.toLowerCase() === rightWsl.distro.toLowerCase() && leftWsl.linuxPath === rightWsl.linuxPath;
		}
		const left = this.normalizeProjectPath(a);
		const right = this.normalizeProjectPath(b);
		// WSL 路径保留原始大小写（Linux 文件系统区分大小写）
		if (process.platform === "win32" && a.startsWith("/") && b.startsWith("/")) {
			return left === right;
		}
		return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	}

	private save(): Promise<void> {
		this.assertWritable();
		const snapshot = this.projects.map((project) => ({ ...project }));
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				this.assertWritable();
				const nextRevision = this.revision + 1;
				await writeProjectStoreSnapshot(this.filePath, snapshot, nextRevision, { skipBackup: this.skipNextBackup });
				this.revision = nextRevision;
				this.skipNextBackup = false;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}
