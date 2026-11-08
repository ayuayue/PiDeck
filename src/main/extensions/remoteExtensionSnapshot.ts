/**
 * 远端内置扩展：镜像表 + 生效快照读取（P4.4 扩展面，`docs/archive/remote/remote-extension-injection-plan.md`）。
 *
 * 这个模块只回答两个问题，都是纯数据/纯函数：
 *
 * 1. **哪些内置扩展允许在远端注入**（`REMOTE_EXTENSION_DISPOSITIONS`）。分类是显式的，不是推断的：
 *    每次新增内置扩展都必须在这里落一个处置，否则类型检查不过——远端「悄悄少一个扩展」是最难
 *    发现的降级（功能看着在、语义不生效），所以宁可让编译失败。
 * 2. **远端要拿到哪份字节**（`readEffectiveExtensionSnapshot`）：本机**当前生效**的那份快照
 *    （热更新覆盖层优先，整份 sha256 校验通过），与 `-e` 注入本机的是同一份文件。远端绝不能
 *    回退到「安装包 base」而本机跑的是覆盖层，那会让远端行为与本机悄悄分叉。
 *
 * 这里不碰远端：上传/部署在 `RemoteExtensionDeployment`，注入参数在 `piRpcArgs`。路径也只在本机
 * 出现——远端路径一律由 content address 拼出，绝不从本机路径推导。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS, resolveBuiltInExtensionPath, type BuiltInExtensionName, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { invalidateVerifiedArtifactFileHashCache, readVerifiedArtifact, type BuiltInExtensionsManifest } from "./builtInExtensionsManifest";

/**
 * 一个内置扩展在**远端会话**里的处置：
 *
 * - `remote`：可以直接注入，无额外运行时输入；
 * - `remote-needs-env`：可以注入，但依赖 PiDeck 经 runner init 帧传下去的 `PIDECK_*` 环境；
 *   环境通道不可用（旧 runner / 未接线）时**不注入**，因为缺环境时它失败方向是「静默失效」；
 * - `local-only`：代码或依赖只对本机有意义（本机回环桥、vendored 原生依赖、本机回收站语义）；
 * - `not-applicable`：在远端平台/场景下没有意义（Windows-only、只在 PiDeck 注入本地代理时有意义）。
 *
 * 新增内置扩展时这里必须补一条：`Record<BuiltInExtensionName, …>` 让遗漏变成类型错误。
 */
export type RemoteExtensionDisposition = "remote" | "remote-needs-env" | "local-only" | "not-applicable";

/**
 * 每个内置扩展的远端处置（理由写在值旁边，改判断前先读）。
 *
 * 判据只有一条：**它需要的东西能不能跨 SSH 边界成立**。凡是依赖「本机 127.0.0.1」「本机文件路径」
 * 「本机平台特有行为」的，一律不进远端；凡是「纯 pi 扩展 API + 会话条目 + RPC UI」的都可以进。
 */
export const REMOTE_EXTENSION_DISPOSITIONS: Record<BuiltInExtensionName, RemoteExtensionDisposition> = {
	// 关联会话工具回调本机端点（`PIDECK_LINKED_SESSIONS_URL`，127.0.0.1），远端 pi 连不到。
	"pi-deck-linked-sessions.ts": "local-only",
	// 模型请求快照经本机端点（`PIDECK_MODEL_TRACE_URL`，127.0.0.1）上传，远端 pi 连不到；
	// 要做先设计 SSH 反向隧道。
	"pi-deck-model-trace.ts": "local-only",
	// 纯 input 钩子 + RPC UI（select/confirm），跨传输成立。
	"pi-deck-request-size-recovery.ts": "remote",
	// 注册 ask_question 工具，交互走 RPC Extension UI 子协议（与传输无关）。
	"pi-deck-ask-question.ts": "remote",
	// 纯 input / agent_end + appendEntry，状态落会话条目。
	"pi-deck-goal-mode.ts": "remote",
	// Git Bash(NUL) 的 Windows-only 修正；远端是 POSIX。
	"pi-deck-nul-redirect-fix.ts": "not-applicable",
	// 纯 input 钩子，按隐藏标记切换只读工具集。
	"pi-deck-plan-mode.ts": "remote",
	// message_end 里改写瞬态错误文案，让 pi 自己的重试名单命中。
	"pi-deck-retry-no-body.ts": "remote",
	// 读 PIDECK_SECURITY_CONFIG / PIDECK_SESSION_ID：缺环境时直接放行（fail-open），所以必须等 env 通道。
	"pi-deck-security-gate.ts": "remote-needs-env",
	// 首轮结束后用**远端**模型生成标题；PIDECK_AUTO_SESSION_TITLE 缺省即开启，关闭用「不注入」表达。
	"pi-deck-session-title.ts": "remote",
	// 订阅第三方 subagent 插件的生命周期事件；远端没装插件就是惰性，落了 record 才能在远端历史里投影。
	"pi-deck-subagents.ts": "remote",
	// 分支作用域的待办状态，落会话条目；依赖同名目录下的 pi-deck-todo-state.ts。
	"pi-deck-todo.ts": "remote",
	// Linux 走 gio trash，进的是**远端主机**的回收站；与 PiDeck 项目内 `.pideck-trash` 不是一套语义，待产品定。
	"pi-deck-trash-guard.ts": "local-only",
	// 依赖 vendored undici（1.6MB / 176 文件，需要子目录），当前快照是扁平声明；S3 再谈。
	"pi-deck-vision.ts": "local-only",
	// 只在 PiDeck 给 pi 进程注入本地代理环境（PIDECK_PI_PROXY_SCOPE）时才有意义；远端没有这份环境。
	"pi-deck-shell-proxy.ts": "not-applicable",
	// 纯 RPC 侧 `reload` 命令（ctx.reload()）：宿主经专用 IPC 触发，远端 pi 同样没有原生 /reload，
	// 且它不依赖任何本机资源，因此可以注入。
	"pi-deck-runtime.ts": "remote",
};

/** 全部内置扩展入口（含内部适配器），顺序与 `-e` 注入顺序一致。 */
export const ALL_BUILT_IN_EXTENSION_NAMES: readonly BuiltInExtensionName[] = [...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS];

/** 一个扩展是否可以被远端注入（`remote-needs-env` 在环境通道可用时才算）。 */
export function isRemoteInjectable(disposition: RemoteExtensionDisposition, envAvailable: boolean): boolean {
	return disposition === "remote" || (disposition === "remote-needs-env" && envAvailable);
}

export type RemoteExtensionListInput = {
	/** 远端已部署快照里实际存在的文件名（来自 content-addressed manifest，不是本机磁盘探测）。 */
	available: ReadonlySet<string>;
	removedBuiltInExtensions?: readonly string[];
	optInBuiltInExtensions?: readonly string[];
	/** 诊断总开关：与本地同语义（一个都不注入）。 */
	noExtensions?: boolean;
	/**
	 * runner init 帧的 env 通道是否可用。S2 之前传 false ⇒ `remote-needs-env` 的扩展（安全门）不注入，
	 * 避免「加载了但拿不到策略 ⇒ 静默放行」这种最坏的假安全。
	 */
	envAvailable?: boolean;
	/** `settings.autoSessionTitle === false` ⇒ 不注入标题扩展（扩展缺省开启，只能靠不注入表达关闭）。 */
	autoSessionTitle?: boolean;
};

/**
 * 本次远端会话实际注入的扩展 basenames，顺序与 `BUILT_IN_EXTENSIONS` 一致（pi 按 `-e` 顺序注册）。
 *
 * 判定顺序刻意与 `listActiveBuiltInExtensionPaths` 对齐：noExtensions → 用户移除 → 远端处置
 * → 快照里存在 → 标题开关。任何一条不满足都跳过，**不抛错**：远端少一个扩展是降级，不是启动失败。
 *
 * 注：dev 已整体下线「默认关闭（opt-in）」与「已隐藏」两组内置扩展（GUI 桥/扩展点面板随之下线），
 * 所以本函数不再有那两道判据；`optInBuiltInExtensions` 入参保留只为兼容既有调用点。
 */
export function listRemoteInjectableExtensionNames(input: RemoteExtensionListInput): string[] {
	if (input.noExtensions === true) return [];
	const removed = new Set((input.removedBuiltInExtensions ?? []).map((name) => name.trim()).filter(Boolean));
	const envAvailable = input.envAvailable === true;
	const names: string[] = [];
	for (const name of ALL_BUILT_IN_EXTENSION_NAMES) {
		if (!isRemoteInjectable(REMOTE_EXTENSION_DISPOSITIONS[name], envAvailable)) continue;
		if (name !== "pi-deck-shell-proxy.ts" && removed.has(name)) continue;
		if (name === "pi-deck-session-title.ts" && input.autoSessionTitle === false) continue;
		if (!input.available.has(name)) continue;
		names.push(name);
	}
	return names;
}

/** 远端注入需要的**依赖文件**：入口文件之间的相对 import 必须一起上传（judged per-file sha256）。 */
const REMOTE_EXTENSION_DEPENDENCY_FILES: readonly string[] = ["pi-deck-todo-state.ts"];

/**
 * 远端快照需要上传的文件名集合：清单里的**全部** `.ts`。
 *
 * 为什么整份上传而不是只传注入的那些：相对 import 是逐文件解析的（todo → todo-state），只挑入口会在
 * 下次新增依赖时静默断链；而且「远端字节 == 本机生效快照」本身就是审计属性，挑子集会让这条不成立。
 * 体积代价可忽略（26 个文件约 524KB）。
 */
export function remoteExtensionSnapshotFileNames(manifest: BuiltInExtensionsManifest): string[] {
	return manifest.files.map((file) => file.name);
}

/** 依赖文件必须在快照里——否则远端 `-e` 加载会在 import 阶段失败。 */
export function hasRemoteExtensionDependencies(names: ReadonlySet<string>): boolean {
	return REMOTE_EXTENSION_DEPENDENCY_FILES.every((name) => names.has(name));
}

export type RemoteExtensionSnapshot = {
	/** 本机生效快照目录（覆盖层优先，否则随包 `resources/extensions`）。 */
	readonly dir: string;
	/** 整份校验通过的清单（fileCount/逐文件 sha256 均由 `readVerifiedArtifact` 复核）。 */
	readonly manifest: BuiltInExtensionsManifest;
};

/**
 * 读取本机**当前生效**的内置扩展快照。
 *
 * 覆盖层（热更新）优先、且必须**整份**校验通过：半截覆盖层（缺文件 / 被外部改动）会让 pi 解析不到
 * 相对 import，此时退回随包 base 是唯一安全行为（与 `resolveBuiltInExtensionPath` 的回落判据同源）。
 * 覆盖层与 base 都校验不过时返回 `undefined` —— 调用方按「远端不注入」降级，绝不拿未校验的字节上传。
 */
export function readEffectiveExtensionSnapshot(roots: BuiltInExtensionPathRoots): RemoteExtensionSnapshot | undefined {
	if (roots.overlayDir) {
		const overlay = readVerifiedArtifact(roots.overlayDir);
		if (overlay) return { dir: roots.overlayDir, manifest: overlay };
	}
	const dir = roots.isDev ? join(roots.appPath, "resources", "extensions") : join(roots.resourcesPath, "extensions");
	const manifest = readVerifiedArtifact(dir);
	if (manifest) return { dir, manifest };
	// 清单缺失（很旧的安装包）：列出目录文件本身不能证明完整性，远端不接手未校验字节。
	return undefined;
}

/**
 * 本机生效快照里的文件是否与 `-e` 注入用的是同一份（覆盖层生效时两者必须一致）。
 *
 * 这不是运行时的必答问题，而是给热更新/诊断用的自我核对：一旦某天 `-e` 走 base、快照走 overlay，
 * 远端会拿到与本机不同的扩展字节，而两边都不会报错。测试与诊断日志用它判定。
 */
export function effectiveExtensionPathsMatchSnapshot(roots: BuiltInExtensionPathRoots, snapshot: RemoteExtensionSnapshot, names: readonly string[]): boolean {
	for (const name of names) {
		const injected = resolveBuiltInExtensionPath(name, roots);
		const expected = join(snapshot.dir, name);
		if (!existsSync(injected) || injected !== expected) return false;
	}
	return true;
}

/** 覆盖层写盘后由热更新器调用（与 builtInExtensions 的同名失效点保持一处）。 */
export function invalidateRemoteExtensionSnapshotCaches(): void {
	invalidateVerifiedArtifactFileHashCache();
}
