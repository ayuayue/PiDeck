import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { getAppLogger } from "../logging/sharedLogger";
import { applyProxyEnvPatch, type HostProxyEnvPatch } from "../sessions/sessionProxyPolicy";
import { DshHostProcess, resolveHostEntryPath } from "./DshHostProcess";
import { DshApiClient, type DshFetchTransport } from "./DshApiClient";
import { toDshAvailableModels, toDshFetchedModels } from "./dshModels";
import { parseAgentDefaultModel } from "./dshDefaultModel";
import { credentialValueFromDocument, isValidCredentialRef } from "./dshCredentials";
import { workspaceDirFor, findDshSessionDir } from "./dshSessionPath";
import {
	migrateLegacyPideckDshFiles,
	pideckArchivePath,
	pideckDshHome,
	pideckHostLockPath,
} from "./pideckDshHome";
import { foldSessionTitleFromDir, listForeignSessionsFromDisk, scanDshSessionHeaders } from "./dshForeignSessionScan";
import { PIDECK_PLUGIN_BRIDGE_PATH } from "./pideckPluginBridge";
import { PIDECK_COMMANDS_BRIDGE_PATH } from "./pideckCommandsBridge";
import type { DshFetchMessage } from "./dshHostBridge";
import type {
	DshCommandView,
	DshPluginBridgeResponse,
	DshPluginInstallInput,
	DshPluginLifecycleInput,
	DshPluginView,
	DshStaticPluginView,
} from "../../shared/types";

// 注意：主进程产物为 CJS，而 @deepseek-ai/* 是 ESM-only 包。
// 静态 import 会被 electron-vite 打包器改写（externalize 后变 require，Node <22.12 无法加载 ESM），
// 因此这里全部用运行时动态 import()（rollup 对 externalized 包的 import() 原样保留）。
// type-only import 会被擦除，可以保留。

/**
 * DSH 深融合宿主（v2 形态）：utilityProcess 承载完整 DSH host，
 * 主进程侧通过 `DshApiClient`（AbstractApiClient 实例，doFetch 走桥）访问
 * 同一 ApiProxy 契约——传输替换对 PiDeck 其余代码完全透明。
 *
 * 形态说明（docs/dsh-agent-backend-plan.md §3.2 形态 b）：
 * - host 在 utilityProcess 里 boot（无 web/无 HTTP/无端口），原生 ABI 与崩溃面
 *   不污染主进程；hostEntry 产物经 electron-vite 多入口打包到 out/main/。
 * - 按需启动：默认后端为 dsh 时窗口首帧后后台预热；纯 pi 用户不 fork host。
 *   发送/历史/配置链路调用 ensureStarted() 幂等兜底。
 * - 桥协议：dshHostBridge.ts（fetch-request/response/chunk/end/error）。
 *
 * DSH_HOME：直接使用用户真实 ~/.dsh（与 dsh CLI 行为一致，配置/凭证/会话
 * 全在同一处），不存在时 mkdirSync 自动创建——不产生两套数据目录漂移。
 * 设置里的 dshHomeDir 覆盖目录优先（自定义路径）。
 */
export class DshHost {
	private hostProcess: DshHostProcess | null = null;
	private apiClient: DshApiClient | null = null;
	private client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient | null = null;
	private startPromise: Promise<void> | null = null;
	private dshHome = "";
	private configDir = "";
	private unsubscribeHostExit: (() => void) | null = null;
	/** host-ready 订阅（首次启动与崩溃自动重启都会触发；DshAgentManager 据此恢复会话，E4）。 */
	private readonly hostReadyListeners = new Set<() => void>();
	/** DSH_HOME 并发锁（B6）：锁文件路径与是否由本实例持有。 */
	private hostLockPath = "";
	private ownsHostLock = false;

	constructor(
		private readonly getUserDataDir: () => string,
		private readonly getAppPath: () => string,
		private readonly log: (scope: string, message: string, detail?: unknown) => void =
			(scope, message, detail) => getAppLogger()?.info(scope, message, detail),
		/** DSH_HOME 覆盖目录 getter（设置里 dshHomeDir）；空串/undefined = 自动用 ~/.dsh。 */
		private readonly getDshHomeOverride: () => string | undefined = () => undefined,
		/**
		 * DSH host 级代理 env patch 解析（由 main/index.ts 聚合所有 DSH 会话的覆盖生成；
		 * set = 注入键值，unset = 从继承环境剥离的键）。缺省 = 沿用现有行为（不注入代理 env）。
		 * 只在 host fork 时生效：运行中变更需 host 重启/下次启动才应用（DSH 无 per-session 通道）。
		 */
		private readonly resolveHostProxyEnvPatch: () => HostProxyEnvPatch | undefined = () => undefined,
		/**
		 * 外部 DSH runtime 根目录（阶段 2：userData/runtimes/dsh/<version>，其下有 node_modules）。
		 * 返回 undefined 时回退 app 内置 node_modules（依赖分区前的存量包走这条）。
		 * 只影响 @deepseek-ai/* 的解析；hostEntry 与桥代码始终在 app 内。
		 */
		private readonly resolveRuntimeAppRoot: () => string | undefined = () => undefined,
		/**
		 * 永久删除归档目录的回收站回调（与 pi 会话删除同语义：可恢复，拒绝静默硬删）。
		 * 主进程装配时注入 electron shell.trashItem；测试注入假实现，保持 DshHost 与 electron 解耦。
		 */
		private readonly trashPath: (path: string) => Promise<void> = () => Promise.reject(new Error("trashPath not injected")),
	) {}

	/** 订阅 host-ready（首次启动与崩溃自动重启；E4：崩溃后恢复运行时状态）。 */
	onHostReady(listener: () => void): () => void {
		this.hostReadyListeners.add(listener);
		return () => {
			this.hostReadyListeners.delete(listener);
		};
	}

	/** 是否已完成引导。 */
	isStarted(): boolean {
		return this.client !== null;
	}

	/** host utilityProcess 是否存活（崩溃重启中返回 false）。 */
	isHostProcessRunning(): boolean {
		return this.hostProcess?.isRunning() ?? false;
	}

	/** host 是否已完成 boot（host-ready 已收到；重启后重新置位）。 */
	isHostReady(): boolean {
		return this.hostProcess?.isReady() ?? false;
	}

	/** host utilityProcess 的 OS pid；未 fork / 已退出返回 undefined。 */
	getHostPid(): number | undefined {
		return this.hostProcess?.pid;
	}

	/** 启动/按需兜底（幂等）：fork host 并建立桥接客户端。 */
	ensureStarted(): Promise<void> {
		if (this.client) return Promise.resolve();
		this.startPromise ??= this.start().catch((error) => {
			this.startPromise = null;
			throw error;
		});
		return this.startPromise;
	}

	/** 已启动时返回领域客户端（未启动返回 null）。 */
	getClient(): import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient | null {
		return this.client;
	}

	/**
	 * settings.describe 的透传视图：每个 namespace 的脱敏 value + schema +
	 * secrets 槽位 + revision。渲染层据此渲染配置表单。
	 */
	async describeSettings(): Promise<{
		writable: boolean;
		hasDocument: boolean;
		namespaces: Array<{
			ns: string;
			applies: string;
			revision: number;
			value: unknown;
			base?: unknown;
			user?: unknown;
			secrets: Array<{ path: string[]; set: boolean }>;
			schema: unknown;
		}>;
	}> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) {
			return { writable: false, hasDocument: false, namespaces: [] };
		}
		const described = await client.settings.describe({});
		if (!described.result.ok) {
			throw new Error(`dsh settings.describe failed: ${JSON.stringify(described.result.error)}`);
		}
		return {
			writable: described.result.value.writable,
			hasDocument: described.result.value.hasDocument,
			namespaces: (described.result.value.namespaces ?? []).map((ns) => ({
				ns: ns.ns,
				applies: ns.applies,
				revision: ns.revision,
				value: ns.value,
				base: ns.base,
				user: ns.user,
				secrets: (ns.secrets ?? []).map((secret) => ({ path: secret.path, set: secret.set })),
				schema: ns.schema,
			})),
		};
	}

	/** settings.update：合并 patch 到 namespace 用户层（secret 可写；返回新脱敏视图）。 */
	async updateSettings(
		ns: string,
		patch: Record<string, unknown>,
		expectedRevision?: number,
	): Promise<unknown> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const updated = await client.settings.update({ ns, patch, expectedRevision });
		if (!updated.result.ok) {
			throw new Error(`dsh settings.update failed: ${JSON.stringify(updated.result.error)}`);
		}
		return updated.result.value;
	}

	/**
	 * settings.mutate：按路径操作编辑 namespace 用户层。
	 * 与 update（merge 只能增改、无法删除）互补：`{ op: "unset", path: [...] }`
	 * 可以删除单个 key（如 llm-pi-ai.providers.<route>），这是配置面删除
	 * provider/字段的唯一正确路径——merge 空 dict 不会删掉现有 key。
	 */
	async mutateSettings(
		ns: string,
		ops: Array<
			| { op: "set"; path: string[]; value: unknown }
			| { op: "unset"; path: string[] }
		>,
		expectedRevision?: number,
	): Promise<unknown> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const updated = await client.settings.mutate({ ns, ops, expectedRevision });
		if (!updated.result.ok) {
			throw new Error(`dsh settings.mutate failed: ${JSON.stringify(updated.result.error)}`);
		}
		return updated.result.value;
	}

	/** credentials.describe：refs 必须匹配 env 名格式（^[A-Za-z_][A-Za-z0-9_]*$）。 */
	async describeCredentials(refs: string[]): Promise<Record<string, {
		configured: boolean;
		source?: string;
		writable: boolean;
	}>> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return {};
		const described = await client.credentials.describe({ refs });
		if (!described.result.ok) return {};
		return described.result.value.credentials ?? {};
	}

	/** credentials.set：写入凭证（唯一值单向通道）。 */
	async setCredential(ref: string, value: string): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const result = await client.credentials.set({ ref, value });
		if (!result.result.ok) {
			throw new Error(`dsh credentials.set failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** credentials.unset：删除凭证（幂等）。 */
	async unsetCredential(ref: string): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const result = await client.credentials.unset({ ref });
		if (!result.result.ok) {
			throw new Error(`dsh credentials.unset failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/**
	 * 读取凭证明文（仅渲染层点「眼睛」时调用一次；DSH RPC 刻意不回显值）。
	 *
	 * 解析层与 dsh-credentials-local 一致：`$DSH_HOME/.credentials.yaml` 是严格
	 * ref→value 映射，环境变量层只读兜底（继承环境 > 凭证文件）。返回 undefined
	 * 表示该 ref 无值（未配置）。ref 必须匹配 env 名格式，杜绝路径注入。
	 */
	async readCredentialValue(ref: string): Promise<string | undefined> {
		if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
		// 环境层（继承进程环境）优先：与 dsh-credentials-local 的优先级一致
		const inherited = process.env[ref];
		if (typeof inherited === "string" && inherited.length > 0) return inherited;
		// 凭证文件层：$DSH_HOME/.credentials.yaml（严格 ref→value 映射）
		const filePath = join(this.getHomeDir(), ".credentials.yaml");
		try {
			const text = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
			return credentialValueFromDocument(text, ref);
		} catch {
			// 文件缺失/读取失败：视为未配置（describe 侧会如实报告状态）
		}
		return undefined;
	}

	/** settings.openDocument：让 host 把配置文档交给平台文本编辑器打开。 */
	async openDocument(): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const result = await client.settings.openDocument({}, new AbortController().signal);
		if (!result.result.ok) {
			throw new Error(`dsh settings.openDocument failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** 当前生效的 DSH_HOME（未启动时按同一解析规则返回「即将使用」的目录）。 */
	getHomeDir(): string {
		const override = this.getDshHomeOverride()?.trim();
		return this.dshHome || resolveDshHomeDir(override, this.getUserDataDir());
	}

	/** DSH 配置管理页数据：host 启动状态 + DSH_HOME 目录 + 最近一次 boot 失败原因。 */
	async getStatus(): Promise<{
		started: boolean;
		homeDir: string;
		/** 最近一次 host boot 失败的真实原因（host-error 详情/stderr 尾部）；成功或从未失败为 null。 */
		bootError?: string | null;
	}> {
		// E14：started 语义 = host 进程存活且 boot 完成（client 非 null 可能在崩溃重启
		// 超限放弃后仍是陈旧引用，UI 会误显示「已启动」）。
		const started = this.client !== null && this.isHostProcessRunning() && this.isHostReady();
		return {
			started,
			homeDir: this.getHomeDir(),
			// boot 失败详情透给渲染层：即使 describe 抛错，概览页也能拿到真实原因。
			bootError: this.hostProcess?.getLastBootError() ?? null,
		};
	}

	/**
	 * Host 级模型目录（llm.models），不依赖已创建的 DSH 会话。
	 * 给草稿/未启动会话的模型下拉用；首次调用会懒 boot。
	 * 与会话级 session.models 同一目录数据，透传每模型支持的思考档位
	 * （reasoningEfforts），思考选择器按当前模型过滤档位。
	 */
	async listModels(): Promise<import("../../shared/types").AvailableModel[]> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const listed = await client.llm.models({});
		if (!listed.result.ok) return [];
		return toDshAvailableModels(listed.result.value.groups ?? []);
	}

	/**
	 * DSH 原生模型发现：配置页传入仍在编辑的草稿，结果只作为候选返回。
	 * apiKey 仅在调用方有未保存草稿时出现；已保存凭证由 DSH 的 adapter/credentials
	 * seam 自己解析，避免 PiDeck 读取并转运密钥。settingsNs 是 adapter 选择的必要契约。
	 */
	async discoverModels(
		input: import("../../shared/types").DshModelDiscoveryInput,
	): Promise<import("../../shared/types").FetchedModel[]> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const settingsNs = input.settingsNs.trim();
		if (!settingsNs) throw new Error("DSH model discovery requires settingsNs");
		const discovered = await client.llm.discoverModels({
			settingsNs,
			...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
			...(input.baseURL?.trim() ? { baseURL: input.baseURL.trim() } : {}),
			...(input.api?.trim() ? { api: input.api.trim() } : {}),
			...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
		});
		if (!discovered.result.ok) {
			throw new Error(`dsh llm.discoverModels failed: ${discovered.result.error.code}: ${discovered.result.error.message}`);
		}
		return toDshFetchedModels(discovered.result.value.models ?? []);
	}

	/**
	 * 归档 DSH 会话（G14，与 pi 归档同语义：目录移动而非销毁）：
	 * 把 host 会话目录移出 sessions 树到 $DSH_HOME/.pideck/archive/<sessionId>，
	 * 并写 manifest（记录原 workspace cwd 与会话标题，恢复时移回原位置）。
	 * host 重启后 session.list 不再包含该会话（目录已不在 sessions 树）。
	 * title 为归档时刻 catalog 里的会话名：不存则恢复/列表只能看到 host id
	 * 或退化为日志折叠（见 listArchivedSessions / unarchiveSession）。
	 * 返回归档目录路径；会话不存在时返回 undefined。
	 */
	async archiveSession(dshSessionId: string, cwd: string, title?: string): Promise<string | undefined> {
		const sourceDir = join(this.getHomeDir(), "sessions", workspaceDirFor(cwd), dshSessionId);
		if (!existsSync(sourceDir)) return undefined;
  const archiveRoot = pideckArchivePath(this.getHomeDir());
		const targetDir = join(archiveRoot, dshSessionId);
		mkdirSync(archiveRoot, { recursive: true });
		if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
		renameSync(sourceDir, targetDir);
		writeFileSync(join(targetDir, "pideck-manifest.json"), JSON.stringify({
			dshSessionId,
			cwd,
			archivedAt: Date.now(),
			// G14+：标题随 manifest 持久化，恢复后列表/会话记录直接可用；
			// 旧归档没有该字段，由读取侧用日志折叠兜底。
			...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
		}), "utf8");
		return targetDir;
	}

	/** 恢复归档的 DSH 会话（G14）：读 manifest 移回原 workspace 目录。返回恢复后的目录、manifest 中的原 cwd 与标题。 */
	async unarchiveSession(dshSessionId: string): Promise<{ restoredPath: string; cwd: string; title?: string } | undefined> {
  const archiveRoot = pideckArchivePath(this.getHomeDir());
		const archivedDir = join(archiveRoot, dshSessionId);
		const manifestPath = join(archivedDir, "pideck-manifest.json");
		if (!existsSync(manifestPath)) return undefined;
		let cwd = "";
		let title: string | undefined;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cwd?: unknown; title?: unknown };
			if (typeof manifest.cwd === "string" && manifest.cwd) cwd = manifest.cwd;
			if (typeof manifest.title === "string" && manifest.title.trim()) title = manifest.title.trim();
		} catch {
			// manifest 损坏：无法恢复原位置
			return undefined;
		}
		const targetDir = join(this.getHomeDir(), "sessions", workspaceDirFor(cwd), dshSessionId);
		mkdirSync(dirname(targetDir), { recursive: true });
		renameSync(archivedDir, targetDir);
		// 旧归档 manifest 无标题时，从恢复后的会话日志前缀只读折叠补全
		// （与 listArchivedSessions 同源；避免恢复后侧栏落「新会话」占位名）。
		if (!title) title = foldSessionTitleFromDir(targetDir);
		return { restoredPath: targetDir, cwd, ...(title ? { title } : {}) };
	}

	/**
	 * 永久删除已归档的 DSH 会话（区别于恢复）：把归档目录移入系统回收站（经注入的 trashPath）。
	 * 幂等：归档目录不存在/非 PiDeck 归档（无 manifest）返回 false；否则删除后返回 true。
	 */
	async deleteArchivedSession(dshSessionId: string): Promise<boolean> {
		const archiveRoot = pideckArchivePath(this.getHomeDir());
		const archivedDir = join(archiveRoot, dshSessionId);
		// 只有带 manifest 的目录才算 PiDeck 归档（与 listArchivedSessions 同判定），避免误删非归档目录。
		const manifestPath = join(archivedDir, "pideck-manifest.json");
		if (!existsSync(manifestPath)) return false;
		await this.trashPath(archivedDir);
		return true;
	}

	/**
	 * 删除活跃 DSH 会话（与 pi 会话删除同语义）：把 host 会话目录移入系统回收站
	 * （经注入的 trashPath，可恢复；回收站不可用时抛错，拒绝静默硬删）。
	 * DSH 官方没有 session.delete 协议，定位/搬移与 archiveSession 同构（移出 sessions 树），
	 * host 重启后 session.list 不再包含该会话。
	 * 幂等：目录不存在（已删/已回收）返回 false。
	 * @param cwd 会话所属 workspace（catalog 记录的 project.path），用于精确推导；
	 *            失配时按 sessionId 兜底扫描（项目目录移动后仍可删除）。
	 */
	async deleteSession(dshSessionId: string, cwd: string): Promise<boolean> {
		const target = findDshSessionDir(this.getHomeDir(), cwd, dshSessionId);
		if (!target) return false;
		await this.trashPath(target);
		return true;
	}

	/**
	 * 归档区中的 DSH 会话清单（G14：恢复入口用；返回 manifest 里的原 workspace cwd、
	 * 归档时间与标题）。标题优先 manifest（G14+ 写入）；旧归档缺省时从归档目录的
	 * 会话日志前缀只读折叠补全（与外部会话导入同源策略）。
	 * manifest 缺失/损坏的目录跳过（无 manifest 不视为 PiDeck 归档）。
	 */
	listArchivedSessions(): Array<import("../../shared/types").ArchivedDshSession> {
  const archiveRoot = pideckArchivePath(this.getHomeDir());
		if (!existsSync(archiveRoot)) return [];
		return readdirSync(archiveRoot, { withFileTypes: true })
			.filter((item) => item.isDirectory())
			.map((item): import("../../shared/types").ArchivedDshSession | undefined => {
				const manifestPath = join(archiveRoot, item.name, "pideck-manifest.json");
				try {
					const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
						dshSessionId?: unknown;
						cwd?: unknown;
						archivedAt?: unknown;
						title?: unknown;
					};
					const dshSessionId = typeof manifest.dshSessionId === "string" ? manifest.dshSessionId : item.name;
					// manifest 携带的标题优先（G14+ 归档时刻写入）；旧归档缺省时
					// 从归档目录的日志前缀折叠，避免归档区只能显示裸 host id。
					const manifestTitle = typeof manifest.title === "string" && manifest.title.trim()
						? manifest.title.trim()
						: undefined;
					const title = manifestTitle ?? foldSessionTitleFromDir(join(archiveRoot, item.name));
					return {
						dshSessionId,
						cwd: typeof manifest.cwd === "string" ? manifest.cwd : "",
						archivedAt: typeof manifest.archivedAt === "number" ? manifest.archivedAt : 0,
						...(title ? { title } : {}),
					};
				} catch {
					return undefined;
				}
			})
			.filter((item): item is import("../../shared/types").ArchivedDshSession => Boolean(item));
	}

	/**
	 * 桥 RPC 通用入口（G13/D15 共用）：经 fetch 桥调 host 侧 pideck-* 桥服务。
	 * 所有桥方法统一走 POST {path}，{ method, params } → { ok, value|error } 信封。
	 */
	private async bridgeRpc(path: string, method: string, params: unknown): Promise<unknown> {
		await this.ensureStarted();
		if (!this.apiClient) throw new Error("DSH host is not started");
		const response = await this.apiClient.rawFetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method, params }),
		});
		let parsed: DshPluginBridgeResponse<unknown>;
		try {
			parsed = JSON.parse(await response.text()) as DshPluginBridgeResponse<unknown>;
		} catch {
			throw new Error(`bridge returned non-JSON response (HTTP ${response.status})`);
		}
		if (parsed.ok !== true) {
			throw new Error(parsed.ok === false ? parsed.error : "bridge request failed");
		}
		return parsed.value;
	}

	/** 动态插件桥（G13 深化）：pideck-plugin-bridge 服务的 RPC 入口。 */
	private async pluginRpc(method: string, params: unknown): Promise<unknown> {
		return this.bridgeRpc(PIDECK_PLUGIN_BRIDGE_PATH, method, params);
	}

	/** 动态插件清单（进程内全部会话的临时扩展；重启即失）。 */
	async listDynamicPlugins(): Promise<DshPluginView[]> {
		const value = await this.pluginRpc("inventory", undefined);
		return Array.isArray(value) ? (value as DshPluginView[]) : [];
	}

	/** 静态 Loader 条目清单（只读：moduleName/enabled/fiberPhase）。 */
	async listStaticPlugins(): Promise<DshStaticPluginView[]> {
		const value = await this.pluginRpc("staticInventory", undefined);
		return Array.isArray(value) ? (value as DshStaticPluginView[]) : [];
	}

	/** 安装动态插件（define：定义源码包，不运行；按会话归属）。 */
	async installDynamicPlugin(input: DshPluginInstallInput): Promise<unknown> {
		return this.pluginRpc("install", input);
	}

	/** 运行动态插件的指定包（面板手势 requestId=null，无需审批）。 */
	async runDynamicPlugin(input: DshPluginLifecycleInput): Promise<unknown> {
		return this.pluginRpc("run", input);
	}

	/** 停止动态插件的活动 run（保留全部包版本）。 */
	async stopDynamicPlugin(input: DshPluginLifecycleInput): Promise<unknown> {
		return this.pluginRpc("stop", input);
	}

	/** 卸载动态插件（undefine：删除插件与全部包版本）。 */
	async uninstallDynamicPlugin(input: DshPluginLifecycleInput): Promise<unknown> {
		return this.pluginRpc("uninstall", input);
	}

	/**
	 * 会话命令枚举（D15）：经 pideck-command-bridge 调 host 命令注册表
	 * （ctx.commands.list(agent)），返回该会话 live Agent 生效的命令描述符。
	 * 会话未激活（无 live Agent）时桥返回结构化错误，主进程抛错，
	 * 渲染层按能力降级为静态建议列表（DSH_COMMAND_SUGGESTIONS）。
	 */
	async listCommands(sessionId: string): Promise<DshCommandView[]> {
		const value = await this.bridgeRpc(PIDECK_COMMANDS_BRIDGE_PATH, "list", { sessionId });
		return Array.isArray(value) ? (value as DshCommandView[]) : [];
	}

	/**
	 * DSH 会话内容搜索（G9）：wire `session.search` 搜索 user/assistant/steering 消息面，
	 * 结果最多 20 个会话（无游标，hasMore 提示收窄查询）。返回 { sessionId, snippet }，
	 * 由渲染层按 dshSessionId 映射回 catalog 记录。
	 */
	async searchSessions(query: string): Promise<Array<{ sessionId: string; snippet: string }>> {
		const trimmed = query.trim();
		if (!trimmed) return [];
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const searched = await client.sessions.search({ query: trimmed }, new AbortController().signal);
		if (!searched.result.ok) return [];
		return (searched.result.value.items ?? []).map((item) => ({
			sessionId: String(item.sessionId),
			snippet: item.snippet,
		}));
	}

	/**
	 * 磁盘上全部已持久化会话 id（G3/D11：孤儿检测用）。
	 * 只读扫 DSH_HOME/sessions，不启动 host——配置页概览不能为了数孤儿去抢 dsh-web。
	 */
	async listSessionIds(): Promise<string[]> {
		return scanDshSessionHeaders(this.getHomeDir()).map((header) => header.id);
	}

	/**
	 * 外部（dsh-web 等其他工具）创建的根会话清单：只读扫磁盘 header，
	 * 不 fork host、不 sessions.list / history。双 host 会互相覆盖 session log。
	 */
	async listForeignSessions(): Promise<Array<{
		dshSessionId: string;
		title?: string;
		cwd?: string;
		updatedAt?: number;
	}>> {
		return listForeignSessionsFromDisk(this.getHomeDir());
	}

	/**
	 * 解析 cwd 对应的 host workspace id（幂等）：走官方 workspace.create({path})，
	 * 已存在目录返回既有 workspace，不会手写 workspace.json。
	 * 新会话必须带这个 workspaceId 创建，host 才会 attachSession；
	 * 只传 cwd 会永远留在 dsh-web「未分组」。失败返回 undefined，由创建方失败，
	 * 不再静默降级成 cwd-only。
	 */
	async resolveWorkspaceId(cwd: string): Promise<import("@deepseek-ai/dsh-host-apiproxy").WorkspaceId | undefined> {
		try {
			await this.ensureStarted();
			const client = this.client;
			if (!client) return undefined;
			const resolved = await client.workspace.create({ path: cwd });
			if (!resolved.result.ok) return undefined;
			return resolved.result.value.workspace.workspaceId;
		} catch {
			return undefined;
		}
	}

	/**
	 * 可配置提供方目录（llm.providers）：内置 catalog（declared，未配置）+
	 * 已注册路由（active）。模型页「添加提供方」从 declared 未激活行中选择，
	 * 与 dsh-web 的休眠目录选择同源。首次调用会懒 boot。
	 */
	async listProviders(): Promise<Array<{
		provider: string;
		displayName: string;
		active: boolean;
		declared?: boolean;
	}>> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const listed = await client.llm.providers({});
		if (!listed.result.ok) return [];
		return (listed.result.value.providers ?? []).map((entry) => ({
			provider: entry.provider,
			displayName: entry.displayName,
			active: entry.active,
			...(entry.declared === true ? { declared: true } : {}),
		}));
	}

	/**
	 * DSH agent 预设目录（agentPreset.list）：会话 agent 的组合预设（standard/code/…）。
	 * 只读展示（id/trust/isDefault/名称/描述），配置页「预设设置」分区用。
	 */
	async listAgentPresets(): Promise<Array<{
		id: string;
		trust: "system" | "user";
		isDefault: boolean;
		name?: string;
		description?: string;
		broken?: string;
	}>> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const listed = await client.agentPresets.list({});
		if (!listed.result.ok) {
			// 目录拉取失败/为空时记日志：会话头模式胶囊与配置页「预设设置」都依赖这份名单，
			// 空名单 = 部署未装配 agent-presets 组合行（此时胶囊按设计隐藏）。
			getAppLogger()?.warn("dsh-host", "agentPreset.list failed", {
				error: JSON.stringify(listed.result.error),
			});
			return [];
		}
		const presets = listed.result.value.presets ?? [];
		if (presets.length === 0) {
			getAppLogger()?.warn("dsh-host", "agentPreset.list returned an empty roster", {
				hint: "agent-presets 组合行未装配时 PiDeck 隐藏会话头模式胶囊（与 dsh-web 一致）",
			});
		}
		return presets.map((preset: {
			id: string;
			trust: "system" | "user";
			isDefault: boolean;
			name?: string;
			description?: string;
			broken?: string;
		}) => ({
			id: preset.id,
			trust: preset.trust,
			isDefault: preset.isDefault,
			...(typeof preset.name === "string" && preset.name ? { name: preset.name } : {}),
			...(typeof preset.description === "string" && preset.description ? { description: preset.description } : {}),
			...(typeof preset.broken === "string" && preset.broken ? { broken: preset.broken } : {}),
		}));
	}

	/**
	 * 部署默认模型选择（settings.yaml 的 agent-default-model 段）。
	 * 草稿/未激活会话的底栏与选择器展示默认模型/思考档位用；无需启动 host
	 * （直接读 DSH_HOME/settings.yaml，host 写出的简单 YAML）。文件缺失或解析
	 * 失败返回 undefined，调用方回退为不展示默认值。
	 */
	getDefaultModelSelection(): import("./dshDefaultModel").DshDefaultModel | undefined {
		const home = this.getHomeDir();
		const filePath = join(home, "settings.yaml");
		if (!existsSync(filePath)) return undefined;
		try {
			return parseAgentDefaultModel(readFileSync(filePath, "utf8"));
		} catch {
			return undefined;
		}
	}

	/**
	 * DSH_HOME 并发锁（B6）：同目录双 host 并发会互相覆盖 session log，DSH 官方
	 * 不支持。锁文件记录主进程 pid：发现存活 pid 时告警（不阻断——dsh CLI 等外部
	 * 进程不遵守本锁，阻断也无法防外部并发，但至少双 PiDeck 实例有提示）。
	 */
	private acquireHostLock(): void {
  this.hostLockPath = pideckHostLockPath(this.dshHome);
		try {
			if (existsSync(this.hostLockPath)) {
				const raw = readFileSync(this.hostLockPath, "utf8");
				const parsed = JSON.parse(raw) as { pid?: unknown };
				const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
				if (Number.isFinite(pid) && isProcessAlive(pid)) {
					this.log("dsh-host", `DSH_HOME 可能正被其他 DSH host 使用（pid=${pid}）：${this.dshHome}`);
				}
			}
			writeFileSync(this.hostLockPath, JSON.stringify({ pid: process.pid }), "utf8");
			this.ownsHostLock = true;
		} catch (error) {
			this.log("dsh-host", "DSH_HOME 锁文件写入失败（继续启动）", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** 释放 DSH_HOME 并发锁（dispose 调用）。 */
	private releaseHostLock(): void {
		if (!this.ownsHostLock || !this.hostLockPath) return;
		try {
			rmSync(this.hostLockPath, { force: true });
		} catch {
			// 释放失败不阻塞退出
		}
		this.ownsHostLock = false;
	}

	private async start(): Promise<void> {
		const userData = this.getUserDataDir();
		const override = this.getDshHomeOverride()?.trim();
		// DSH_HOME 解析：设置覆盖 > ~/.dsh（统一入口，新用户也用 ~/.dsh，不另起炉灶）。
		this.dshHome = resolveDshHomeDir(override, userData);
		if (override) {
			this.log("dsh-host", `DSH_HOME 使用用户配置目录：${override}`);
		} else {
			this.log("dsh-host", "DSH_HOME 使用用户 ~/.dsh（与 dsh CLI 共用配置/会话）");
		}
		this.configDir = join(userData, "dsh-config");
		mkdirSync(this.dshHome, { recursive: true });
		mkdirSync(this.configDir, { recursive: true });
		// PiDeck 私有文件统一落 $DSH_HOME/.pideck/：先搬旧位置数据（幂等），再创建目录。
		// 注：migrateLegacyPideckDshFiles 是一次性迁移（旧布局仅开发/试用环境存在），
		// 确认无残留后随下一版删除该调用（见 pideckDshHome.ts 头部「生命周期」说明）。
		migrateLegacyPideckDshFiles(this.dshHome);
		mkdirSync(pideckDshHome(this.dshHome), { recursive: true });
		this.acquireHostLock();

		// 定位 hostEntry 产物与 node_modules 锚点（bareModuleBaseUrl）。
		// @deepseek-ai/* 现在可能来自外部 runtime（阶段 2：userData/runtimes/dsh/<v>），
		// 因此 require 基准改用 runtime 目录而不是 appPath；未装 runtime 时回退内置。
		// hostEntry 仍是 PiDeck 自己的产物，继续从 appPath 解析。
		const runtimeRoot = this.resolveRuntimeAppRoot?.() ?? this.getAppPath();
		const require = createRequire(join(runtimeRoot, "package.json"));
		const appRoot = dirname(dirname(dirname(require.resolve("@deepseek-ai/dsh-base/package.json"))));
		const hostEntryPath = resolveHostEntryPath(this.getAppPath());

		// 会话级代理覆盖（DSH 降级方案）：DSH 是单一共享 host，无法按会话注入，
		// 只能聚合所有 DSH 会话的开关应用到 host（off 优先于 on，见 sessionProxyPolicy）。
		// patch 仅在 fork 时生效：运行中变更需 host 重启后才应用。
		// 生效机制：patch 除标准代理 env（HTTP_PROXY/HTTPS_PROXY/NO_PROXY）外，还注入
		// NODE_USE_ENV_PROXY=1 —— host 的 LLM 客户端用 globalThis.fetch（undici），
		// 默认不读代理环境变量，没有该开关注入的 env 只是摆设（实测确认）。
		// 注意：这会使 host 内所有 undici fetch 都走代理（含 dsh.internal 内网桥除外——
		// 桥走主进程 fetch，不在 host 内发请求），需要绕过本机的场景请配置 bypass。
		const forkEnv = buildDshHostForkEnv();
		const proxyPatch = this.resolveHostProxyEnvPatch();
		if (proxyPatch) applyProxyEnvPatch(forkEnv, proxyPatch);

		const hostProcess = new DshHostProcess(
			hostEntryPath,
			[
				`--dsh-home=${this.dshHome}`,
				`--dsh-config=${this.configDir}`,
				`--dsh-node-modules=${pathToFileURL(appRoot + "/").href}`,
			],
			// E5：utilityProcess.fork 的 env 显式传入即整体替换——传 {} 会让 host 以
			// 近空环境运行（无 PATH/SystemRoot 等），host 内 spawn 的 bash/pwsh 子进程
			// 依赖这些变量。改为继承主进程环境并剔除 Electron/Node 宿主注入类变量
			// （ELECTRON_*/NODE_OPTIONS），避免污染 DSH 子进程树。
			forkEnv,
			(scope, message, detail) => this.log(scope, message, detail),
		);
		this.hostProcess = hostProcess;
		// 崩溃联动：host 进程退出（运行中崩溃）时中断全部在途桥 fetch（mux 长连接），
		// 否则 pump 的 for await 悬挂在永远不会结束的流上——会话静默断开的根因。
		this.unsubscribeHostExit?.();
		this.unsubscribeHostExit = hostProcess.onExit(() => {
			this.apiClient?.abortAllPending();
		});
		// host-ready 转发（首次启动与崩溃自动重启）：订阅者恢复崩溃前状态（E4）。
		hostProcess.onReady(() => {
			for (const listener of this.hostReadyListeners) {
				try {
					listener();
				} catch {
					// 订阅者异常不影响 host-ready 处理
				}
			}
		});
		// 先 fork 并等 host-ready：桥消息必须等 host 侧监听就绪后才能发。
		// start(true)：首次预热、按需兜底或用户重启时都重置连续崩溃计数（E3）。
		await hostProcess.start(true);

		const transport: DshFetchTransport = {
			send: (message: DshFetchMessage) => hostProcess.postMessage(message),
			onMessage: (listener) => hostProcess.onMessage((message) => listener(message as DshFetchMessage)),
			dispose: () => {
				void hostProcess.kill();
			},
		};
		this.apiClient = new DshApiClient({
			transport,
			// 与 hostEntry 一致：CJS 产物里裸 import() 会走默认解析（打包后找不到 app node_modules），
			// 必须按 file URL 动态导入（createRequire 解析真实路径）。
			loadModule: () => import(pathToFileURL(require.resolve("@deepseek-ai/dsh-host-apiproxy")).href),
			log: (message, detail) => this.log("dsh-bridge", message, detail),
		});
		try {
			// 覆写后的客户端即领域客户端（doFetch 走桥）。
			const client = await this.apiClient.getClient();
			this.client = client;
		} catch (error) {
			// E10：启动失败路径必须清理已 fork 的 host 进程与 apiClient——否则下次
			// ensureStarted 会再 fork 一个新 host，双 host 进程并存。
			this.log("dsh-host", "host client init failed; cleaning up forked host", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.apiClient.dispose();
			this.apiClient = null;
			this.unsubscribeHostExit?.();
			this.unsubscribeHostExit = null;
			await hostProcess.dispose().catch(() => undefined);
			this.hostProcess = null;
			this.releaseHostLock();
			throw error;
		}
		this.log("dsh-host", "host ready（utilityProcess）");
	}

	/** 显式 dispose（应用退出清理清单调用）。 */
	async dispose(): Promise<void> {
		if (this.startPromise) {
			try {
				await this.startPromise;
			} catch {
				// boot 失败时无需 dispose
			}
		}
		if (this.apiClient) {
			this.apiClient.dispose();
			this.apiClient = null;
		}
		if (this.hostProcess) {
			this.unsubscribeHostExit?.();
			this.unsubscribeHostExit = null;
			await this.hostProcess.dispose();
			this.hostProcess = null;
		}
		this.client = null;
		this.startPromise = null;
		this.releaseHostLock();
	}

	/** 重启 host（DSH_HOME 切换后立即生效）：dispose 后清空状态，
	 * 下次 ensureStarted 按新目录重新 fork。调用方（main/index.ts 的
	 * restartDshHost IPC）会先停掉活跃 DSH 会话，避免旧 mux 悬挂。
	 */
	async restart(): Promise<void> {
		await this.dispose();
		this.log("dsh-host", "host 已重置，下次启动将重新 fork");
	}
}

/**
 * DSH_HOME 目录解析（纯函数，可单测）：
 * 1. 设置里 dshHomeDir 非空 → 以用户覆盖为准（任意自定义目录）；
 * 2. 否则一律用 ~/.dsh（与 dsh CLI 共用同一目录；不存在时由调用方 mkdirSync 自动创建）。
 */
export function resolveDshHomeDir(
	override: string | undefined,
	_realUserDataDir: string,
): string {
	if (override?.trim()) return override.trim();
	return join(homedir(), ".dsh");
}

/** 进程是否存活（B6 锁检测用）：kill(pid, 0) 成功 = 存活；EPERM = 存在但无权限，也算存活。 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** DSH host fork 环境（E5）：继承主进程环境，剔除 Electron/Node 宿主注入类变量。 */
function buildDshHostForkEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// ELECTRON_*（如 ELECTRON_RUN_AS_NODE/ELECTRON_NO_ASAR）与 NODE_OPTIONS
		// （可能带 --require preload 注入）不该进 DSH 子进程树。
		if (key.startsWith("ELECTRON_") || key === "NODE_OPTIONS") continue;
		env[key] = value;
	}
	return env;
}
