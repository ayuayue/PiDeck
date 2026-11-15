import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { buildDshHostForkEnv, isProcessAlive, resolveDshHomeDir } from "./dshHostEnv";
import { describeDshCredentials, describeDshSettings, mutateDshSettings, openDshSettingsDocument, readDshCredentialValue, readDshDefaultModelSelection, setDshCredential, unsetDshCredential, updateDshSettings, type DshSettingsView } from "./dshHostSettings";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dshRuntimeMissingError } from "./dshRuntimeMissing";
import { getAppLogger } from "../logging/sharedLogger";
import { applyProxyEnvPatch, type HostProxyEnvPatch } from "../sessions/sessionProxyPolicy";
import { DshHostProcess, resolveHostEntryPath } from "./DshHostProcess";
import { DSH_RUNNER_NODE_ENV } from "./dshRunnerNodeSidecar";
import { resolveDshRunnerNodePath } from "./dshRunnerNode";
import { DshApiClient, type DshFetchTransport } from "./DshApiClient";
import { dshManuallyStoppedError } from "./dshManualStop";
import { applyDshBillBackfillPatch } from "./dshBillBackfillPatch";
import { DshRemoteClient } from "./dshRemoteClient";
import { discoverDshModels, listDshAgentPresets, listDshModels, listDshProviders } from "./dshHostCatalog";
import { archiveDshSession, deleteArchivedDshSession, deleteDshSession, listArchivedDshSessions, unarchiveDshSession } from "./dshHostArchive";
import { dshSessionFilePath } from "./dshSessionPath";
import { toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import { migrateLegacyPideckDshFiles, pideckDshHome, pideckHostLockPath } from "./pideckDshHome";
import { listDshSessionIds, listForeignDshSessions, resolveDshWorkspaceId, searchDshSessions } from "./dshHostSessions";
import { externalHostHolderPid, resolveDshHomeSharing } from "./dshHomeSharing";
import type { DshHomeSharingState } from "../../shared/types/dshHome";
import { ensureUserPatchLayerIsArrayDocument, USER_PATCH_FILENAME } from "./dshUserPlugins";
import { installDshDynamicPlugin, listDshCommands, listDshDynamicPlugins, listDshStaticPlugins, readDshSessionCursor, runDshDynamicPlugin, stopDshDynamicPlugin, uninstallDshDynamicPlugin, uninstallDshUserPlugin, type DshPluginHostDeps } from "./dshHostPlugins";
import type { DshFetchMessage } from "./dshHostBridge";
import type { DshCommandView, DshPluginBridgeResponse, DshPluginInstallInput, DshPluginLifecycleInput, DshPluginView, DshStaticPluginView, DshUserPluginUninstallInput, DshUserPluginUninstallResult } from "../../shared/types";

// 域协作者拆出后仍从这里转出的纯函数（主进程装配与测试都从 DshHost 取这两个符号）：
// DSH_HOME 解析 / 进程存活 / fork env 在 dshHostEnv.ts，settings 冲突判定在 dshHostSettings.ts。
export { resolveDshHomeDir } from "./dshHostEnv";
export { isDshSettingsConflict } from "./dshHostSettings";

// 注意：主进程产物为 CJS，而 @deepseek-ai/* 是 ESM-only 包。
// 静态 import 会被 electron-vite 打包器改写（externalize 后变 require，Node <22.12 无法加载 ESM），
// 因此这里全部用运行时动态 import()（rollup 对 externalized 包的 import() 原样保留）。
// type-only import 会被擦除，可以保留。

/**
 * DSH 深融合宿主（v2 形态）：utilityProcess 承载完整 DSH host，
 * 主进程侧通过 `DshApiClient`（AbstractApiClient 实例，doFetch 走桥）访问
 * 同一 ApiProxy 契约——传输替换对 PiDeck 其余代码完全透明。
 *
 * 形态说明（docs/archive/plans/dsh-agent-backend-plan.md §3.2 形态 b）：
 * - host 在 utilityProcess 里 boot（无 web/无 HTTP/无端口），原生 ABI 与崩溃面
 *   不污染主进程；hostEntry 产物经 electron-vite 多入口打包到 out/main/。
 * - 启动预热：runtime 已安装且用户没手动停止过 host 时，窗口首帧后后台预热（不等用户
 *   先把默认后端切成 dsh——装 runtime 本身就是显式选择，boot 约 20s，装了就该提前拉起）；
 *   纯 pi 且未装 runtime 的用户不 fork host，发送/历史/配置链路调用 ensureStarted() 幂等兜底。
 * - 桥协议：dshHostBridge.ts（fetch-request/response/chunk/end/error）。
 *
 * DSH_HOME：直接使用用户真实 ~/.dsh（与 dsh CLI 行为一致，配置/凭证/会话
 * 全在同一处），不存在时 mkdirSync 自动创建——不产生两套数据目录漂移。
 * 设置里的 dshHomeDir 覆盖目录优先（自定义路径）。
 */
export class DshHost {
	private hostProcess: DshHostProcess | null = null;
	private apiClient: DshApiClient | null = null;
	/** 0.1.5 领域客户端（Typert Remote 适配层；见 dshRemoteClient.ts）。 */
	private client: DshRemoteClient | null = null;
	private startPromise: Promise<void> | null = null;
	private dshHome = "";
	private configDir = "";
	private unsubscribeHostExit: (() => void) | null = null;
	/** host-ready 订阅（首次启动与崩溃自动重启都会触发；DshAgentManager 据此恢复会话，E4）。 */
	private readonly hostReadyListeners = new Set<() => void>();
	/** DSH_HOME 并发锁（B6）：锁文件路径与是否由本实例持有。 */
	private hostLockPath = "";
	private ownsHostLock = false;
	/**
	 * 当前 WSL 环境（装配时经 configureWsl 注入，与 AgentManager.configureWsl 同一时机）。
	 * DSH host 是 Windows 原生进程：它拿到的路径必须能被 Windows 的 node:fs realpath 解析，
	 * 而 WSL 模式下项目记录的是 Linux 路径（/mnt/h/...）——直接交给 host 会被当成
	 * 当前盘根目录（realpath('/mnt/h/x') → C:\mnt）而报 ENOENT，会话必然创建失败。
	 */
	private wslEnvironment: WslEnvironment | null = null;

	constructor(
		private readonly getUserDataDir: () => string,
		private readonly getAppPath: () => string,
		private readonly log: (scope: string, message: string, detail?: unknown) => void = (scope, message, detail) => getAppLogger()?.info(scope, message, detail),
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
		 * 返回 undefined 时仅在旧 full/存量包兼容模式下回退 app 内置 node_modules；新的 dev/lite
		 * 路径由上层安装态门控，不把项目 node_modules 当作已发布 runtime。
		 * 只影响 @deepseek-ai/* 的解析；hostEntry 与桥代码始终在 app 内。
		 */
		private readonly resolveRuntimeAppRoot: () => string | undefined = () => undefined,
		/**
		 * 永久删除归档目录的回收站回调（与 pi 会话删除同语义：可恢复，拒绝静默硬删）。
		 * 主进程装配时注入 electron shell.trashItem；测试注入假实现，保持 DshHost 与 electron 解耦。
		 */
		private readonly trashPath: (path: string) => Promise<void> = () => Promise.reject(new Error("trashPath not injected")),
		/**
		 * Windows 沙箱 runner 的本机 CUI node。空串/undefined = 自动探测。
		 * 改路径后需重启 host 才写入 fork env。
		 */
		private readonly getDshRunnerNodePath: () => string | undefined = () => undefined,
		/**
		 * 用户是否手动停止了 DSH host（设置项 dshManualStopped，持久化跨重启）。
		 * 为真时所有「自动拉起」路径（ensureStarted 按需兜底 / 后台预热 / 崩溃自动重启 /
		 * runtime 磁盘操作后恢复）一律不 fork，只有用户显式调用 startManually() 才放行。
		 * 缺省 false = 保持按需自动启动的历史语义。
		 */
		private readonly isManualStopped: () => boolean = () => false,
		/**
		 * agent-team 实验预设开关（设置项 dshAgentTeamPreset，默认关）。仅在 fork 时
		 * 读取并经 --dsh-agent-team=1 传给 hostEntry：组合层变更无 per-session 通道，
		 * 切换后需重启 DSH host 才对新旧会话生效（崩溃自动重启复用同 argv，开关快照不变）。
		 */
		private readonly isAgentTeamPresetEnabled: () => boolean = () => false,
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

	/** 是否处于「用户手动停止」状态（不想让它运行；自动拉起路径据此拒绝 fork）。 */
	isManuallyStopped(): boolean {
		return this.isManualStopped();
	}

	/**
	 * 启动/按需兜底（幂等）：fork host 并建立桥接客户端。
	 *
	 * 手动停止优先：用户显式停过之后，所有自动路径（发送/历史/配置读取的兜底、
	 * 后台预热、崩溃重启）都不再拉起——否则「停了一次又被某某后台任务悄悄拉回来」，
	 * 用户会认为停止没生效。想恢复必须由用户在配置页点「启动」（走 startManually）。
	 */
	ensureStarted(): Promise<void> {
		if (this.client) return Promise.resolve();
		if (this.isManualStopped()) {
			return Promise.reject(dshManuallyStoppedError());
		}
		this.startPromise ??= this.start().catch((error) => {
			this.startPromise = null;
			throw error;
		});
		return this.startPromise;
	}

	/**
	 * 用户显式启动（清除手动停止语义后 boot）：配置页「启动」按钮走这里。
	 * 必须由上层先把 settings.dshManualStopped 写成 false 再调用——本方法只负责 boot，
	 * 不改 persisted 状态（DshHost 不持有 SettingsStore 写权限，保持单向依赖）。
	 */
	async startManually(): Promise<boolean> {
		// 已在跑就直接返回成功（重复点「启动」不该 dispose 重建）。
		if (this.isStarted() && this.isHostProcessRunning() && this.isHostReady()) return true;
		try {
			await this.ensureStarted();
		} catch {
			return false;
		}
		return this.isHostProcessRunning() && this.isHostReady();
	}

	/** 已启动时返回领域客户端（未启动返回 null）。 */
	getClient(): DshRemoteClient | null {
		return this.client;
	}

	/**
	 * settings.describe 的透传视图：每个 namespace 的脱敏 value + schema +
	 * secrets 槽位 + revision。渲染层据此渲染配置表单。
	 */
	async describeSettings(): Promise<DshSettingsView> {
		return describeDshSettings(this);
	}

	/** settings.update：合并 patch 到 namespace 用户层（secret 可写；返回新脱敏视图）。 */
	async updateSettings(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown> {
		return updateDshSettings(this, ns, patch, expectedRevision);
	}

	/**
	 * settings.mutate：按路径操作编辑 namespace 用户层。
	 * 与 update（merge 只能增改、无法删除）互补：`{ op: "unset", path: [...] }`
	 * 可以删除单个 key（如 llm-pi-ai.providers.<route>），这是配置面删除
	 * provider/字段的唯一正确路径——merge 空 dict 不会删掉现有 key。
	 */
	async mutateSettings(ns: string, ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>, expectedRevision?: number): Promise<unknown> {
		return mutateDshSettings(this, ns, ops, expectedRevision);
	}

	/** credentials.describe：refs 必须匹配 env 名格式（^[A-Za-z_][A-Za-z0-9_]*$）。 */
	async describeCredentials(refs: string[]): Promise<
		Record<
			string,
			{
				configured: boolean;
				source?: string;
				writable: boolean;
			}
		>
	> {
		return describeDshCredentials(this, refs);
	}

	/** credentials.set：写入凭证（唯一值单向通道）。 */
	async setCredential(ref: string, value: string): Promise<void> {
		return setDshCredential(this, ref, value);
	}

	/** credentials.unset：删除凭证（幂等）。 */
	async unsetCredential(ref: string): Promise<void> {
		return unsetDshCredential(this, ref);
	}

	/**
	 * 读取凭证明文（仅渲染层点「眼睛」时调用一次；DSH RPC 刻意不回显值）。
	 *
	 * 解析层与 dsh-credentials-local 一致：`$DSH_HOME/.credentials.yaml` 是严格
	 * ref→value 映射，环境变量层只读兜底（继承环境 > 凭证文件）。返回 undefined
	 * 表示该 ref 无值（未配置）。ref 必须匹配 env 名格式，杜绝路径注入。
	 */
	async readCredentialValue(ref: string): Promise<string | undefined> {
		return readDshCredentialValue(this, ref);
	}

	/** settings.openDocument：让 host 把配置文档交给平台文本编辑器打开。 */
	async openDocument(): Promise<void> {
		return openDshSettingsDocument(this);
	}

	/** 当前生效的 DSH_HOME（未启动时按同一解析规则返回「即将使用」的目录）。 */
	getHomeDir(): string {
		const override = this.getDshHomeOverride()?.trim();
		return this.dshHome || resolveDshHomeDir(override, this.getUserDataDir());
	}

	/**
	 * 注入当前 WSL 环境（null = 非 WSL 模式或未配置）。
	 *
	 * 边界约定：进出 DSH host 的路径按「Windows 主机视角」处理——workspace 建/解析，
	 * 以及 host 自己按 workspace 路径编码的会话目录（$DSH_HOME/sessions/<编码>/<sessionId>）。
	 * 上层（DshAgentManager、index.ts 的 IPC 装配）继续用项目记录的路径（WSL 模式下是
	 * /mnt/... 形式），转换只发生在这一层，避免主机路径渗进 tab.cwd / catalog / 渲染层
	 * ——渲染层拿 agent.cwd 当文件链接与编辑器的 baseDir，Linux 路径才是它要的形式。
	 */
	configureWsl(environment: WslEnvironment | null): void {
		this.wslEnvironment = environment;
	}

	/**
	 * 交给 DSH host 的路径统一走这里转成 Windows 主机路径。
	 * 转换失败（相对路径 / 不支持的 UNC / 发行版不匹配）保持原样：让 host 报出真实错误，
	 * 好过在这里换成一个更让人困惑的路径。
	 */
	private toHostPath(path: string): string {
		if (!this.wslEnvironment) return path;
		try {
			return toWindowsHostPath(path, this.wslEnvironment);
		} catch {
			return path;
		}
	}

	/**
	 * 会话日志文件路径：必须按 host 实际使用的 workspace 路径编码。
	 * WSL 项目在 host 侧是 H:\...，用 /mnt/h/... 编码会得到一个 host 从未写过的目录
	 * （「复制会话文件路径」指向假路径，删除/归档只能靠 sessionId 兜底扫描）。
	 */
	sessionFilePath(cwd: string, sessionId: string): string {
		return dshSessionFilePath(this.getHomeDir(), this.toHostPath(cwd), sessionId);
	}

	/** DSH 配置管理页数据：host 启动状态 + DSH_HOME 目录 + 最近一次 boot 失败原因。 */
	async getStatus(): Promise<{
		started: boolean;
		homeDir: string;
		/** 最近一次 host boot 失败的真实原因（host-error 详情/stderr 尾部）；成功或从未失败为 null。 */
		bootError?: string | null;
		/** DSH_HOME 共享/冲突状态（issue #189 问题 1：与 dsh CLI 共用目录会互相覆盖状态）。 */
		sharing: DshHomeSharingState;
		/** 用户是否手动停止了 host（true 时不会自动启动，只有显式「启动」才拉起）。 */
		manuallyStopped: boolean;
	}> {
		// E14：started 语义 = host 进程存活且 boot 完成（client 非 null 可能在崩溃重启
		// 超限放弃后仍是陈旧引用，UI 会误显示「已启动」）。
		const started = this.client !== null && this.isHostProcessRunning() && this.isHostReady();
		const homeDir = this.getHomeDir();
		return {
			started,
			homeDir,
			// boot 失败详情透给渲染层：即使 describe 抛错，概览页也能拿到真实原因。
			bootError: this.hostProcess?.getLastBootError() ?? null,
			manuallyStopped: this.isManualStopped(),
			sharing: {
				...resolveDshHomeSharing({
					dshHome: homeDir,
					override: this.getDshHomeOverride(),
					homeDir: homedir(),
				}),
				// 双 PiDeck 实例可检测：锁文件记录的 pid 仍存活且不是自己。
				// 外部 dsh CLI 不写该锁，属已知盲区（sharesCliHome 负责兜底提示）。
				externalHostPid: this.readExternalHostPid(),
			},
		};
	}

	/**
	 * 读锁文件取「另一个存活 DSH host」的 pid（无/陈旧/自己持有 = undefined）。
	 * 只读不写：getStatus 是纯查询路径，不得因为看一眼状态就改锁。
	 */
	private readExternalHostPid(): number | undefined {
		const lockPath = this.hostLockPath || pideckHostLockPath(this.getHomeDir());
		let raw: string | undefined;
		try {
			if (!existsSync(lockPath)) return undefined;
			raw = readFileSync(lockPath, "utf8");
		} catch {
			// 锁文件读不到（权限/占用）：无法判定，按无冲突处理。
			return undefined;
		}
		return externalHostHolderPid({
			lockRaw: raw,
			selfPid: process.pid,
			isAlive: isProcessAlive,
		});
	}

	/**
	 * Host 级模型目录（llm.models），不依赖已创建的 DSH 会话。
	 * 给草稿/未启动会话的模型下拉用；首次调用会懒 boot。
	 * 与会话级 session.models 同一目录数据，透传每模型支持的思考档位
	 * （reasoningEfforts），思考选择器按当前模型过滤档位。
	 */
	async listModels(): Promise<import("../../shared/types").AvailableModel[]> {
		return listDshModels(this);
	}

	/**
	 * DSH 原生模型发现：配置页传入仍在编辑的草稿，结果只作为候选返回。
	 * apiKey 仅在调用方有未保存草稿时出现；已保存凭证由 DSH 的 adapter/credentials
	 * seam 自己解析，避免 PiDeck 读取并转运密钥。settingsNs 是 adapter 选择的必要契约。
	 */
	async discoverModels(input: import("../../shared/types").DshModelDiscoveryInput): Promise<import("../../shared/types").FetchedModel[]> {
		return discoverDshModels(this, input);
	}

	/**
	 * 归档 DSH 会话（G14，与 pi 归档同语义：目录移动而非销毁）：
	 * 把 host 会话目录移出 sessions 树到 $DSH_HOME/.pideck/archive/<sessionId>，
	 * 并写 manifest（记录原 workspace cwd 与会话标题，恢复时移回原位置）。
	 * host 重启后 session.list 不再包含该会话（目录已不在 sessions 树）。
	 * title 为归档时刻 catalog 里的会话名：不存则恢复/列表只能看到 host id
	 * 或退化为日志折叠（见 listArchivedSessions / unarchiveSession）。
	 * 返回归档目录路径；会话不存在时返回 undefined。
	 * @param cwd 上层传入的项目路径（catalog 记录的 project.path）；目录定位按 host 视角转换后编码。
	 */
	async archiveSession(dshSessionId: string, cwd: string, title?: string): Promise<string | undefined> {
		return archiveDshSession(this.getHomeDir(), { dshSessionId, cwd, hostCwd: this.toHostPath(cwd), title });
	}

	/** 恢复归档的 DSH 会话（G14）：读 manifest 移回原 workspace 目录。返回恢复后的目录、manifest 中的原 cwd 与标题。 */
	async unarchiveSession(dshSessionId: string): Promise<{ restoredPath: string; cwd: string; title?: string } | undefined> {
		return unarchiveDshSession(this.getHomeDir(), dshSessionId, (path) => this.toHostPath(path));
	}

	/**
	 * 永久删除已归档的 DSH 会话（区别于恢复）：把归档目录移入系统回收站（经注入的 trashPath）。
	 * 幂等：归档目录不存在/非 PiDeck 归档（无 manifest）返回 false；否则删除后返回 true。
	 */
	async deleteArchivedSession(dshSessionId: string): Promise<boolean> {
		return deleteArchivedDshSession(this.getHomeDir(), dshSessionId, this.trashPath);
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
		return deleteDshSession(this.getHomeDir(), this.toHostPath(cwd), dshSessionId, this.trashPath);
	}

	/**
	 * 归档区中的 DSH 会话清单（G14：恢复入口用；返回 manifest 里的原 workspace cwd、
	 * 归档时间与标题）。标题优先 manifest（G14+ 写入）；旧归档缺省时从归档目录的
	 * 会话日志前缀只读折叠补全（与外部会话导入同源策略）。
	 * manifest 缺失/损坏的目录跳过（无 manifest 不视为 PiDeck 归档）。
	 */
	/**
	 * 2027-02 性能审计改异步：旧归档缺标题时逐目录读 256KiB 日志前缀 + zstd 同步解压，
	 * 归档条目多时同步实现把主进程事件循环堵数百 ms（打开归档管理页整窗卡）。
	 * 现在每个归档目录处理前让出一轮事件循环；目录遍历走 fs/promises。
	 */
	async listArchivedSessions(): Promise<Array<import("../../shared/types").ArchivedDshSession>> {
		return listArchivedDshSessions(this.getHomeDir());
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

	/** 动态插件桥（G13 深化）的依赖面：rpc 走宿主的 bridgeRpc（私有传输入口）。 */
	private pluginBridgeDeps(): DshPluginHostDeps {
		return {
			rpc: (path, method, params) => this.bridgeRpc(path, method, params),
			homeDir: this.getHomeDir(),
			userDataDir: this.getUserDataDir(),
			trashPath: this.trashPath,
			log: (scope, message, detail) => this.log(scope, message, detail),
		};
	}

	/** 动态插件清单（进程内全部会话的临时扩展；重启即失）。 */
	async listDynamicPlugins(): Promise<DshPluginView[]> {
		return listDshDynamicPlugins(this.pluginBridgeDeps());
	}

	/** 静态 Loader 条目清单（origin 标注来源：user = 用户补丁层 / builtin = 官方与 PiDeck 组合）。 */
	async listStaticPlugins(): Promise<DshStaticPluginView[]> {
		return listDshStaticPlugins(this.pluginBridgeDeps());
	}

	/**
	 * 卸载用户自装的静态插件：从 $DSH_HOME/cordis.patch.yml 移除对应行（下个 host
	 * 重启生效），可选把插件目录移入回收站（仅限 userData/dsh-plugins 内的 PiDeck
	 * 管理目录）。内置条目一律拒绝——它们属于 base/预设/PiDeck 组合，不归用户卸载。
	 */
	async uninstallUserPlugin(input: DshUserPluginUninstallInput): Promise<DshUserPluginUninstallResult> {
		return uninstallDshUserPlugin(this.pluginBridgeDeps(), input);
	}

	/** 安装动态插件（define：定义源码包，不运行；按会话归属）。 */
	async installDynamicPlugin(input: DshPluginInstallInput): Promise<unknown> {
		return installDshDynamicPlugin(this.pluginBridgeDeps(), input);
	}

	/** 运行动态插件的指定包（面板手势 requestId=null，无需审批）。 */
	async runDynamicPlugin(input: DshPluginLifecycleInput): Promise<unknown> {
		return runDshDynamicPlugin(this.pluginBridgeDeps(), input);
	}

	/** 停止动态插件的活动 run（保留全部包版本）。 */
	async stopDynamicPlugin(input: DshPluginLifecycleInput): Promise<unknown> {
		return stopDshDynamicPlugin(this.pluginBridgeDeps(), input);
	}

	/** 卸载动态插件（undefine：删除插件与全部包版本）。 */
	async uninstallDynamicPlugin(input: DshPluginLifecycleInput): Promise<unknown> {
		return uninstallDshDynamicPlugin(this.pluginBridgeDeps(), input);
	}

	/**
	 * 会话命令枚举（D15）：经 pideck-command-bridge 调 host 命令注册表
	 * （ctx.commands.list(agent)），返回该会话 live Agent 生效的命令描述符。
	 * 会话未激活（无 live Agent）时桥返回结构化错误，主进程抛错，
	 * 渲染层按能力降级为静态建议列表（DSH_COMMAND_SUGGESTIONS）。
	 */
	async listCommands(sessionId: string): Promise<DshCommandView[]> {
		return listDshCommands((path, method, params) => this.bridgeRpc(path, method, params), sessionId);
	}

	/**
	 * 冷读会话日志 cursor（0.1.5 `session/page` 的 throughSeq 上界）。
	 *
	 * 契约见 pideckSessionBridge：cursor 来自 host 内 sessionQuery 的
	 * observation（与 page 内部 sourceFor 同一数据源），不激活会话、不写投影缓存；
	 * 取 cursor 与后续 page 之间日志只可能增长，旧 cursor 仍是合法切点。
	 * 空日志返回 -1（page 拿到 -1 会返回空页）。
	 * 返回非合法数字（桥未挂载/返回异常）时抛错，由调用方（historyPage）回退。
	 */
	async readSessionCursor(sessionId: string): Promise<number> {
		return readDshSessionCursor((path, method, params) => this.bridgeRpc(path, method, params), sessionId);
	}

	/**
	 * DSH 会话内容搜索（G9）：wire `session.search` 搜索 user/assistant/steering 消息面，
	 * 结果最多 20 个会话（无游标，hasMore 提示收窄查询）。返回 { sessionId, snippet }，
	 * 由渲染层按 dshSessionId 映射回 catalog 记录。
	 */
	async searchSessions(query: string): Promise<Array<{ sessionId: string; snippet: string }>> {
		return searchDshSessions(this, query);
	}

	/**
	 * 磁盘上全部已持久化会话 id（G3/D11：孤儿检测用）。
	 * 只读扫 DSH_HOME/sessions，不启动 host——配置页概览不能为了数孤儿去抢 dsh-web。
	 */
	async listSessionIds(): Promise<string[]> {
		return listDshSessionIds(this.getHomeDir());
	}

	/**
	 * 外部（dsh-web 等其他工具）创建的根会话清单：只读扫磁盘 header，
	 * 不 fork host、不 sessions.list / history。双 host 会互相覆盖 session log。
	 */
	async listForeignSessions(): Promise<
		Array<{
			dshSessionId: string;
			title?: string;
			cwd?: string;
			updatedAt?: number;
		}>
	> {
		return listForeignDshSessions(this.getHomeDir());
	}

	/**
	 * 解析 cwd 对应的 host workspace id（幂等）：走官方 workspace.create({path})，
	 * 已存在目录返回既有 workspace，不会手写 workspace.json。
	 * 新会话必须带这个 workspaceId 创建，host 才会 attachSession；
	 * 只传 cwd 会永远留在 dsh-web「未分组」。失败返回 undefined，由创建方失败，
	 * 不再静默降级成 cwd-only。
	 * @param cwd 上层传入的项目路径；发给 host 前转成 Windows 主机路径（host 用
	 *            node:fs realpath 归一化 path，Linux 路径在 Windows 上必然 ENOENT）。
	 */
	async resolveWorkspaceId(cwd: string): Promise<import("@deepseek-ai/dsh-workspace/types").WorkspaceId | undefined> {
		return resolveDshWorkspaceId(this, this.toHostPath(cwd));
	}

	/**
	 * 可配置提供方目录（llm.providers）：内置 catalog（declared，未配置）+
	 * 已注册路由（active）。模型页「添加提供方」从 declared 未激活行中选择，
	 * 与 dsh-web 的休眠目录选择同源。首次调用会懒 boot。
	 */
	async listProviders(): Promise<
		Array<{
			provider: string;
			displayName: string;
			active: boolean;
			declared?: boolean;
		}>
	> {
		return listDshProviders(this);
	}

	/**
	 * DSH agent 预设目录（agentPresets/list）：会话 agent 的组合预设（standard/ptc/…）。
	 * 只读展示（id/isDefault/名称/描述），配置页「预设设置」分区用。
	 */
	async listAgentPresets(): Promise<
		Array<{
			id: string;
			isDefault: boolean;
			name?: string;
			description?: string;
			broken?: string;
		}>
	> {
		return listDshAgentPresets(this);
	}

	/** 草稿会话读取已保存的 profile 默认模型；尚未迁移时兼容旧 settings.yaml。 */
	getDefaultModelSelection(): import("./dshDefaultModel").DshDefaultModel | undefined {
		return readDshDefaultModelSelection(this.getHomeDir());
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
		// 门控在读到这里时才判定（而非只在 ensureStarted 入口）：startPromise 可能在
		// 用户点「停止」之前就已建好，晚到的 await 不该越过刚刚生效的停止决定。
		if (this.isManualStopped()) throw dshManuallyStoppedError();
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
		// 用户补丁层自愈：旧版本卸载最后一个用户插件后只留下表头注释（空文档），
		// 而 dsh 0.2.0-rc.2 起要求补丁文件顶层必须是 YAML 数组，否则 loadOptionalPatches
		// 直接抛错、host 起不来。fork 前补成 `[]`，用户不必手动编辑 ~/.dsh。
		if (ensureUserPatchLayerIsArrayDocument(join(this.dshHome, USER_PATCH_FILENAME))) {
			this.log("dsh-host", `用户补丁层是空文档，已补成合法空数组：${join(this.dshHome, USER_PATCH_FILENAME)}`);
		}
		this.acquireHostLock();

		// 定位 hostEntry 产物与 node_modules 锚点（bareModuleBaseUrl）。
		// @deepseek-ai/* 现在可能来自外部 runtime（阶段 2：userData/runtimes/dsh/<v>），
		// 因此 require 基准改用 runtime 目录；新的 dev/lite 未安装时不会启动 host，旧 full/存量包
		// 才允许通过 appPath 继续解析内置依赖。
		// hostEntry 仍是 PiDeck 自己的产物，继续从 appPath 解析。
		const runtimeRoot = this.resolveRuntimeAppRoot?.() ?? this.getAppPath();
		const require = createRequire(join(runtimeRoot, "package.json"));
		// @deepseek-ai/* 自阶段 2 起外置为 runtime 资源（app.asar 里本就没有它们），未安装 runtime
		// 时这里必然解析失败。没有守卫的话 MODULE_NOT_FOUND 会沿 ensureClient → IPC 抛到渲染层，
		// 会话历史分页整页失败且原因不可读（#375）。收敛成结构化错误，让调用方识别为「运行时未安装」。
		let appRoot: string;
		try {
			appRoot = dirname(dirname(dirname(require.resolve("@deepseek-ai/dsh-base/package.json"))));
		} catch (error) {
			throw dshRuntimeMissingError(runtimeRoot, error);
		}
		const hostEntryPath = resolveHostEntryPath(this.getAppPath());

		// dsh-bill 启动回填默认关（CPU 修复）：必须在 fork 前对 host 实际加载的那份
		// dsh-bill 应用文件补丁——require 锚点与 hostEntry 的 require.resolve 同源
		//（runtimeRoot），dev / 打包内置 / userData 安装的 runtime 三种形态都命中。
		// 失败不阻断 boot（fail-open：保持官方行为，只是 CPU 问题仍在）。
		try {
			applyDshBillBackfillPatch(require.resolve("dsh-bill"), (message, detail) => this.log("dsh-host", message, detail));
		} catch (error) {
			this.log("dsh-host", "dsh-bill 回填补丁异常（继续启动）", { error: String(error) });
		}

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
		// Windows 沙箱 runner 改走 CUI node sidecar（B 方案）：host 仍是 utilityProcess，
		// 但 runner 不再用 electron.exe，避免 AllocConsole 闪窗。路径写入 fork env，
		// hostEntry 在补丁安装前 configureDshRunnerNodeSidecar。
		const runnerNode = await resolveDshRunnerNodePath({
			platform: process.platform,
			configuredPath: this.getDshRunnerNodePath(),
			envPath: process.env[DSH_RUNNER_NODE_ENV],
			userDataPath: this.getUserDataDir(),
			resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
			appPath: this.getAppPath(),
		});
		if (runnerNode) forkEnv[DSH_RUNNER_NODE_ENV] = runnerNode;

		const hostProcess = new DshHostProcess(
			hostEntryPath,
			[`--dsh-home=${this.dshHome}`, `--dsh-config=${this.configDir}`, `--dsh-node-modules=${pathToFileURL(appRoot + "/").href}`, ...(this.isAgentTeamPresetEnabled() ? ["--dsh-agent-team=1"] : [])],
			// E5：utilityProcess.fork 的 env 显式传入即整体替换——传 {} 会让 host 以
			// 近空环境运行（无 PATH/SystemRoot 等），host 内 spawn 的 bash/pwsh 子进程
			// 依赖这些变量。改为继承主进程环境并剔除 Electron/Node 宿主注入类变量
			// （ELECTRON_*/NODE_OPTIONS），避免污染 DSH 子进程树。
			forkEnv,
			(scope, message, detail) => this.log(scope, message, detail),
			// 崩溃自动重启不经过 DshHost.start，必须把手动停止门控透传到进程层。
			() => this.isManualStopped(),
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
			log: (message, detail) => this.log("dsh-bridge", message, detail),
		});
		// 0.1.5：领域客户端是 Typert Remote 适配层（旧 AbstractApiClient 已废）。
		this.client = new DshRemoteClient(this.apiClient);
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
