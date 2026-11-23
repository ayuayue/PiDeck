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

export { REMOTE_EXTENSION_DISPOSITIONS, type RemoteExtensionDisposition } from "../../shared/remoteExtensionDisposition";
import { REMOTE_EXTENSION_DISPOSITIONS, type RemoteExtensionDisposition } from "../../shared/remoteExtensionDisposition";

/** Keep the shared display policy exhaustive for every built-in entry. */
const checkedDispositions: Record<BuiltInExtensionName, RemoteExtensionDisposition> = REMOTE_EXTENSION_DISPOSITIONS;

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
		if (!isRemoteInjectable(checkedDispositions[name], envAvailable)) continue;
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
