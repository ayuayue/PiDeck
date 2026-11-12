/**
 * 远端会话**根解析与身份推导**（会话根在哪、id 怎么折、登记/标题该读哪个文件）。
 *
 * 从扫描器里拆出来的原因：三条根（默认/user-level/项目级）与两套 id 命名空间必须只有一份实现，
 * 而扫描动作（列目录、预算、上限）与「根在哪」是两件事。这里只做后者：每次操作最多读两份有界配置
 * （`<home>/.pi/agent/settings.json`、`<项目根>/.pi/settings.json`）再拼绝对路径，不列目录、不读正文。
 *
 * 远端访问面沿用注入的 `RemoteSessionTreeSource`（一次性命令 / helper 会话两个实现），因此这里不 import
 * node:fs，也不关心传输方式。
 */
import { REMOTE_WORKSPACE_MAX_HEAD_BYTES } from "../remote/RemoteWorkspaceReader";
// 项目 cwd → pi 的 encoded-cwd 目录名：编码规则只允许一份（归属判定与项目级 id 共用）。
import { encodePiSessionDirectory } from "../remote/remoteSessionProjectMatch";
import type { RemoteSessionTreeSource } from "./RemoteSessionScanSource";
import {
	isAbsoluteRemotePath,
	readProjectSessionId,
	readRemoteHome,
	remoteSessionIdWithinRoot,
	resolveConfiguredSessionDir,
	resolveProjectConfiguredSessionDir,
	REMOTE_SESSION_AGENT_DIR_SUFFIX,
	REMOTE_SESSION_CODES,
	REMOTE_SESSION_PROJECT_ID_PREFIX,
	REMOTE_SESSION_ROOT_SUFFIX,
	REMOTE_SESSION_SETTINGS_FILE_NAME,
	type RemoteSessionIdentityResolution,
	type RemoteSessionProjectCandidate,
} from "./remoteSessionIdentity";

/** pi 的项目级配置文件（与 cwd 同目录）：项目级 `sessionDir` 只从这里读。 */
const PROJECT_SETTINGS_RELATIVE_PATH = ".pi/" + REMOTE_SESSION_SETTINGS_FILE_NAME;

/** 远端 home 的两个入口（只读 / 确保式）；与连接服务结构上兼容，不需要 import 具体实现。 */
export type RemoteSessionHomePort = {
	remoteHome(hostId: string): Promise<string | undefined>;
	remoteHomeEnsuring?(hostId: string): Promise<string | undefined>;
};

export type RemoteSessionRootContext = { readonly ok: true; readonly home: string; readonly root: string; readonly customSessionDir: boolean } | { readonly ok: false; readonly code: string };

export type RemoteSessionRootResolution = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly code: string };

/** 一个扫描根及其 id 前缀（默认根是空前缀；项目级 `sessionDir` 是 `project:<encoded>/`）。 */
export type RemoteSessionScanRoot = { readonly root: string; readonly idPrefix: string };

export type RemoteSessionRootsDeps = {
	readonly port: RemoteSessionHomePort;
	readonly treeSource: RemoteSessionTreeSource;
	/** 该主机上的远端项目清单：项目级根的发现与 `project:` 命名空间的解析都靠它。 */
	readonly projectCandidates?: (hostId: string) => readonly RemoteSessionProjectCandidate[];
	/** 默认根 id 的归属解析（装配注入；项目级 id 用命名空间直接判定，不走这里）。 */
	readonly projectIdForHost?: (hostId: string, remoteSessionId: string) => string | undefined;
	/** hostId 的权威判据（扫描器同一份 `readHostId`）：身份推导的入参边界不能比扫描更宽。 */
	readonly readHostId: (value: unknown) => string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRemoteSessionRoots(deps: RemoteSessionRootsDeps) {
	const { port, treeSource } = deps;

	/**
	 * 全局会话根上下文（J2，供 scan / title / register / 身份推导共用）：
	 * home（握手）→ <home>/.pi/agent/settings.json 的 `sessionDir`（有界读，≤64 KiB）→ 默认 <home>/.pi/agent/sessions。
	 *
	 * 三种结果分得很清：
	 * - 配置**缺失 / 读不到 / 不是文件 / 畸形 JSON / 截断** ⇒ 默认根（不让扫描整体失败）；
	 * - 配置里的 `sessionDir` **不可用**（非字符串、相对路径、控制字节、逃出 home）⇒ 稳定码
	 *   REMOTE_SESSION_SESSION_DIR_INVALID，**不退回默认根**：那会在配了自定义目录的机器上给出看起来正常但错的列表；
	 * - 合法（含 `~` 展开与 `.`/`..` 规范化）⇒ 用它当会话根。
	 */
	async function resolveRootContext(hostId: string): Promise<RemoteSessionRootContext> {
		let home: unknown;
		try {
			// 优先「确保式」：扫描通常紧跟登记/读取项目之后，而那条路径会在任务结束时收掉它建立的临时
			// 会话 —— 纯读会正好落进「没有缓存状态」的窗口并报 home 不可用（真机 e2e 实测：前后状态都
			// 是 ready，同主机稍后再扫就成功）。端口没提供确保式方法时退回只读，既有测试替身不受影响。
			const ensureHome = port.remoteHomeEnsuring;
			home = typeof ensureHome === "function" ? await ensureHome.call(port, hostId) : await port.remoteHome(hostId);
		} catch {
			return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
		}
		const homeDir = readRemoteHome(home);
		if (homeDir === undefined) return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
		const configured = await readConfiguredSessionDir(hostId, homeDir);
		if (!configured.ok) return configured;
		return { ok: true, home: homeDir, root: configured.sessionDir ?? homeDir + "/" + REMOTE_SESSION_ROOT_SUFFIX, customSessionDir: configured.sessionDir !== undefined };
	}

	async function resolveSessionRoot(hostId: string): Promise<RemoteSessionRootResolution> {
		const context = await resolveRootContext(hostId);
		return context.ok ? { ok: true, root: context.root } : context;
	}

	/**
	 * 读 user-level `settings.json` 并取出 `sessionDir`（pi 证据见模块头部）。
	 * 读不到/非文件/畸形/非对象 JSON 都返回 `{ ok: true }`（= 未配置 ⇒ 默认根）。
	 */
	async function readConfiguredSessionDir(hostId: string, home: string): Promise<{ readonly ok: true; readonly sessionDir?: string } | { readonly ok: false; readonly code: string }> {
		let raw: string | undefined;
		try {
			const head = await treeSource.withRoot(hostId, home + "/" + REMOTE_SESSION_AGENT_DIR_SUFFIX, (tree) => tree.readHead(REMOTE_SESSION_SETTINGS_FILE_NAME, REMOTE_WORKSPACE_MAX_HEAD_BYTES));
			// 配置可能截断多字节字符：U+FFFD 落在字符串里会让 JSON.parse 失败，于是按「未配置」处理。
			raw = new TextDecoder().decode(head.content);
		} catch {
			// 不存在 / 不是普通文件 / 权限 / 传输失败：一律按「未配置」处理。
			raw = undefined;
		}
		if (raw === undefined) return { ok: true };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { ok: true };
		}
		if (!isRecord(parsed)) return { ok: true };
		const value = parsed.sessionDir;
		// pi 的判据是 `sessionDir ? normalizePath(sessionDir) : sessionDir`：falsy（含空串）等于未配置。
		if (value === undefined || value === null || value === "") return { ok: true };
		if (typeof value !== "string") return { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid };
		const sessionDir = resolveConfiguredSessionDir(value, home);
		return sessionDir === undefined ? { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid } : { ok: true, sessionDir };
	}

	/**
	 * 读**项目级** `.pi/settings.json` 的 `sessionDir`（有界头读，≤64 KiB）。
	 *
	 * 与 user-level 同一套失败口径：配置缺失/读不到/畸形 ⇒ 未配置（退回默认根）；值存在但不可用 ⇒
	 * 稳定码拒绝（不静默扫错目录）。pi 的 settings 是 user + project 合并的，项目级写 `sessionDir`
	 * 就会覆盖 user-level，所以「默认根 + 项目根」两份都要扫，不能只认其中一份。
	 */
	async function readProjectSessionDir(hostId: string, home: string, projectRemotePath: string): Promise<{ readonly ok: true; readonly sessionDir?: string } | { readonly ok: false; readonly code: string }> {
		if (!isAbsoluteRemotePath(projectRemotePath)) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
		let raw: string | undefined;
		try {
			const head = await treeSource.withRoot(hostId, projectRemotePath, (tree) => tree.readHead(PROJECT_SETTINGS_RELATIVE_PATH, REMOTE_WORKSPACE_MAX_HEAD_BYTES));
			raw = new TextDecoder().decode(head.content);
		} catch {
			raw = undefined;
		}
		if (raw === undefined) return { ok: true };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { ok: true };
		}
		if (!isRecord(parsed)) return { ok: true };
		const value = parsed.sessionDir;
		if (value === undefined || value === null || value === "") return { ok: true };
		if (typeof value !== "string") return { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid };
		const sessionDir = resolveProjectConfiguredSessionDir(value, home, projectRemotePath);
		return sessionDir === undefined ? { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid } : { ok: true, sessionDir };
	}

	/**
	 * 会话归属（同步、零远端往返）：项目级 id 从命名空间直接得到项目；默认根交给装配的 resolver。
	 * 没有归属就不该建立会话，也不该为一个必失败的操作发远端请求。
	 */
	function resolveProjectIdForSessionId(hostId: string, remoteSessionId: string): { readonly ok: true; readonly projectId: string } | { readonly ok: false; readonly code: string } {
		const scoped = readProjectSessionId(remoteSessionId);
		if (scoped === null) return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
		if (scoped !== undefined) {
			const project = findProjectByEncodedCwd(hostId, scoped.encodedCwd);
			return project === undefined ? { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved } : { ok: true, projectId: project.id };
		}
		const projectId = deps.projectIdForHost?.(hostId, remoteSessionId);
		return typeof projectId === "string" && projectId.length > 0 ? { ok: true, projectId } : { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
	}

	/** 项目级 id 的归属：只查装配给的候选清单（同步、零远端往返）。 */
	function findProjectByEncodedCwd(hostId: string, encodedCwd: string): RemoteSessionProjectCandidate | undefined {
		return (deps.projectCandidates?.(hostId) ?? []).find((candidate) => encodePiSessionDirectory(candidate.remotePath) === encodedCwd);
	}

	/**
	 * 本次**项目级**扫描要看的根。
	 *
	 * - 默认/user-level 根：未自定义时只扫**当前项目的 encoded-cwd 目录**（主机级扫描会把同主机其他项目的
	 *   会话也列进来）；user-level 自定义 `sessionDir` 是平铺的，没有 cwd 段，无法按项目切分 ⇒ 继续整根扫。
	 * - 项目的 `.pi/settings.json` 配了 `sessionDir`：额外扫它（同一根不重复扫，默认根优先——默认根的 id
	 *   是既有的，不能因为多了一个根就换身份）。
	 */
	async function resolveScanRoots(hostId: string, projectId: string): Promise<{ readonly ok: true; readonly roots: readonly RemoteSessionScanRoot[] } | { readonly ok: false; readonly code: string }> {
		const context = await resolveRootContext(hostId);
		if (!context.ok) return context;
		const project = (deps.projectCandidates?.(hostId) ?? []).find((candidate) => candidate.id === projectId);
		if (project === undefined) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
		const encodedCwd = encodePiSessionDirectory(project.remotePath);
		const roots: RemoteSessionScanRoot[] = [];
		roots.push(context.customSessionDir ? { root: context.root, idPrefix: "" } : { root: context.root + "/" + encodedCwd, idPrefix: encodedCwd + "/" });
		const projectDir = await readProjectSessionDir(hostId, context.home, project.remotePath);
		if (!projectDir.ok) return projectDir;
		if (projectDir.sessionDir !== undefined && projectDir.sessionDir !== context.root) {
			roots.push({ root: projectDir.sessionDir, idPrefix: REMOTE_SESSION_PROJECT_ID_PREFIX + encodedCwd + "/" });
		}
		const seen = new Set<string>();
		return {
			ok: true,
			roots: roots.filter((spec) => {
				if (seen.has(spec.root)) return false;
				seen.add(spec.root);
				return true;
			}),
		};
	}

	/**
	 * `remoteSessionId` → 实际文件位置。读/登记只有这一条路径推导：默认根与项目级根的差别只在这里。
	 */
	async function resolveRootForRemoteSessionId(hostId: string, remoteSessionId: string): Promise<{ readonly ok: true; readonly root: string; readonly relative: string } | { readonly ok: false; readonly code: string }> {
		const scoped = readProjectSessionId(remoteSessionId);
		if (scoped === undefined) {
			const resolved = await resolveSessionRoot(hostId);
			return resolved.ok ? { ok: true, root: resolved.root, relative: remoteSessionId } : resolved;
		}
		if (scoped === null) return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
		const project = findProjectByEncodedCwd(hostId, scoped.encodedCwd);
		if (project === undefined) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
		const context = await resolveRootContext(hostId);
		if (!context.ok) return context;
		const projectDir = await readProjectSessionDir(hostId, context.home, project.remotePath);
		if (!projectDir.ok) return projectDir;
		if (projectDir.sessionDir === undefined) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
		return { ok: true, root: projectDir.sessionDir, relative: scoped.relative };
	}

	/**
	 * pi 上报的**绝对**会话文件 → catalog 身份（`remoteSessionId`）。
	 *
	 * 默认根优先：既存的 id 规则不变（`<相对默认根>`）；项目级 `sessionDir` 之下才用命名空间 id。
	 * 扫描登记与会话运行时登记必须都走这里，否则同一文件会出现两条侧栏记录。
	 */
	async function identityForPath(input: { hostId: string; projectId: string; projectRemotePath: string; remotePath: string }): Promise<RemoteSessionIdentityResolution> {
		const hostId = deps.readHostId(input?.hostId);
		if (hostId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
		const remotePath = isAbsoluteRemotePath(input.remotePath) ? input.remotePath : undefined;
		if (remotePath === undefined) return { ok: false, code: REMOTE_SESSION_CODES.locatorUnresolved };
		const context = await resolveRootContext(hostId);
		if (!context.ok) return context;
		const defaultId = remoteSessionIdWithinRoot(context.root, remotePath);
		if (defaultId !== undefined) return { ok: true, remoteSessionId: defaultId };
		const projectRoot = isAbsoluteRemotePath(input.projectRemotePath) ? input.projectRemotePath : undefined;
		if (projectRoot === undefined || typeof input.projectId !== "string" || input.projectId.length === 0) return { ok: false, code: REMOTE_SESSION_CODES.locatorUnresolved };
		const projectDir = await readProjectSessionDir(hostId, context.home, projectRoot);
		if (!projectDir.ok) return { ok: false, code: projectDir.code };
		if (projectDir.sessionDir === undefined) return { ok: false, code: REMOTE_SESSION_CODES.locatorUnresolved };
		const relative = remoteSessionIdWithinRoot(projectDir.sessionDir, remotePath);
		if (relative === undefined) return { ok: false, code: REMOTE_SESSION_CODES.locatorUnresolved };
		return { ok: true, remoteSessionId: REMOTE_SESSION_PROJECT_ID_PREFIX + encodePiSessionDirectory(projectRoot) + "/" + relative };
	}

	return { resolveRootContext, resolveSessionRoot, readProjectSessionDir, resolveScanRoots, resolveRootForRemoteSessionId, resolveProjectIdForSessionId, identityForPath };
}
