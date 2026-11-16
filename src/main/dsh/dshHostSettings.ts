import { join } from "node:path";
import { credentialValueFromDocument, isValidCredentialRef } from "./dshCredentials";
import { isRecord, readDshSettingsSnapshot } from "./dshProfileSettings";
import type { DshDefaultModel } from "./dshDefaultModel";
import type { DshRemoteClient } from "./dshRemoteClient";

/**
 * DSH 配置面（settings / credentials / 默认模型）的宿主协作者。
 *
 * 宿主（DshHost）只保留同名薄包装，启动兜底（ensureStarted）与领域客户端
 * 由宿主经宿主接口透传——本模块不做进程/生命周期判断。
 */
export type DshSettingsHost = {
	ensureStarted(): Promise<void>;
	getClient(): DshRemoteClient | null;
	getHomeDir(): string;
};

/** settings.describe 的透传视图（每个 namespace 的脱敏 value + schema + secrets 槽位 + revision）。 */
export type DshSettingsView = {
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
};

/**
 * settings.describe 的透传视图：每个 namespace 的脱敏 value + schema +
 * secrets 槽位 + revision。渲染层据此渲染配置表单。
 */
export async function describeDshSettings(host: DshSettingsHost): Promise<DshSettingsView> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) {
		return { writable: false, hasDocument: false, namespaces: [] };
	}
	const described = await client.settingsDescribe();
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
export async function updateDshSettings(host: DshSettingsHost, ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) throw new Error("DSH host is not started");
	return writeDshNamespace(client, ns, "update", expectedRevision, (revision) => client.settingsUpdate({ ns, patch, expectedRevision: revision }));
}

/**
 * settings.mutate：按路径操作编辑 namespace 用户层。
 * 与 update（merge 只能增改、无法删除）互补：`{ op: "unset", path: [...] }`
 * 可以删除单个 key（如 llm-pi-ai.providers.<route>），这是配置面删除
 * provider/字段的唯一正确路径——merge 空 dict 不会删掉现有 key。
 */
export async function mutateDshSettings(host: DshSettingsHost, ns: string, ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>, expectedRevision?: number): Promise<unknown> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) throw new Error("DSH host is not started");
	return writeDshNamespace(client, ns, "mutate", expectedRevision, (revision) => client.settingsMutate({ ns, ops, expectedRevision: revision }));
}

/**
 * DSH settings 写入统一入口（update/mutate 共用）：settings-conflict 冲突重试。
 *
 * 背景：渲染层保存时持有的 revision 来自页面加载时的 settings.describe。
 * 同一保存动作里的多次写入（如批量删除 provider 时每个 unset 各一次 mutate）
 * 共用同一个过期 revision——第一次写入成功后 revision 已递增，后续全部被拒；
 * dsh-web / host 热加载等外部并发写也会让本页 revision 过期。渲染层 update
 * 链路自带「重 describe 再试一次」，但 mutate 直调链路没有——统一收口在主进程：
 * 命中冲突时重读该 namespace 的最新 revision 再试（最多 3 次尝试）。
 * 重试安全性：update 是部分合并、mutate unset/set 是幂等路径操作，
 * 对「读到的最新值」重放不会放大副作用。
 */
async function writeDshNamespace(
	client: DshRemoteClient,
	ns: string,
	label: "update" | "mutate",
	expectedRevision: number | undefined,
	write: (revision: number | undefined) => Promise<{
		result: { ok: true; value: unknown } | { ok: false; error: unknown };
	}>,
): Promise<unknown> {
	let revision = expectedRevision;
	const MAX_ATTEMPTS = 3;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		const result = await write(revision);
		if (result.result.ok) return result.result.value;
		const error = result.result.error;
		// 非冲突错误（schema 拒绝等）与重试耗尽：原样上抛，保留 code/message
		// 供渲染层既有的冲突匹配（"changed since it was read"）与错误展示使用。
		if (!isDshSettingsConflict(error) || attempt === MAX_ATTEMPTS) {
			throw new Error(`dsh settings.${label} failed: ${JSON.stringify(error)}`);
		}
		// 冲突：重读 namespace 拿最新 revision 再试；describe 失败时退化为
		// 不带乐观校验（undefined）的最后一次重试。
		revision = await readNamespaceRevision(client, ns);
	}
	// 循环内必然 return/throw，这里仅满足 TS 控制流分析。
	throw new Error(`dsh settings.${label} failed: exhausted retries`);
}

/** settings.describe 的单 namespace revision 读取（冲突重试用）；describe 失败返回 undefined。 */
async function readNamespaceRevision(client: DshRemoteClient, ns: string): Promise<number | undefined> {
	try {
		const described = await client.settingsDescribe();
		if (!described.result.ok) return undefined;
		const found = (described.result.value.namespaces ?? []).find((item) => item.ns === ns);
		return typeof found?.revision === "number" ? found.revision : undefined;
	} catch {
		return undefined;
	}
}

/** credentials.describe：refs 必须匹配 env 名格式（^[A-Za-z_][A-Za-z0-9_]*$）。 */
export async function describeDshCredentials(
	host: DshSettingsHost,
	refs: string[],
): Promise<
	Record<
		string,
		{
			configured: boolean;
			source?: string;
			writable: boolean;
		}
	>
> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) return {};
	const described = await client.credentialsDescribe({ refs });
	if (!described.result.ok) return {};
	return described.result.value.credentials ?? {};
}

/** credentials.set：写入凭证（唯一值单向通道）。 */
export async function setDshCredential(host: DshSettingsHost, ref: string, value: string): Promise<void> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) throw new Error("DSH host is not started");
	const result = await client.credentialsSet({ ref, value });
	if (!result.result.ok) {
		throw new Error(`dsh credentials.set failed: ${JSON.stringify(result.result.error)}`);
	}
}

/** credentials.unset：删除凭证（幂等）。 */
export async function unsetDshCredential(host: DshSettingsHost, ref: string): Promise<void> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) throw new Error("DSH host is not started");
	const result = await client.credentialsUnset({ ref });
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
export async function readDshCredentialValue(host: DshSettingsHost, ref: string): Promise<string | undefined> {
	if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
	// 环境层（继承进程环境）优先：与 dsh-credentials-local 的优先级一致
	const inherited = process.env[ref];
	if (typeof inherited === "string" && inherited.length > 0) return inherited;
	// 凭证文件层：$DSH_HOME/.credentials.yaml（严格 ref→value 映射）
	const filePath = join(host.getHomeDir(), ".credentials.yaml");
	try {
		const text = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
		return credentialValueFromDocument(text, ref);
	} catch {
		// 文件缺失/读取失败：视为未配置（describe 侧会如实报告状态）
	}
	return undefined;
}

/** settings.openDocument：让 host 把配置文档交给平台文本编辑器打开。 */
export async function openDshSettingsDocument(host: DshSettingsHost): Promise<void> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) throw new Error("DSH host is not started");
	const result = await client.settingsOpenDocument(new AbortController().signal);
	if (!result.result.ok) {
		throw new Error(`dsh settings.openDocument failed: ${JSON.stringify(result.result.error)}`);
	}
}

/** 草稿会话读取已保存的 profile 默认模型；尚未迁移时兼容旧 settings.yaml。 */
export function readDshDefaultModelSelection(homeDir: string): DshDefaultModel | undefined {
	try {
		const value = readDshSettingsSnapshot(homeDir)["agent-default-model"];
		if (!isRecord(value) || typeof value.provider !== "string" || !value.provider || typeof value.model !== "string" || !value.model) return undefined;
		return { provider: value.provider, model: value.model, ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}) };
	} catch {
		return undefined;
	}
}

/**
 * 判定 DSH settings 写入错误是否为乐观并发冲突（revision 过期）。
 * host 的结构化错误 code 是 "settings-conflict"（连字符小写），消息含
 * "changed since it was read"；两者任一命中即视为冲突（容错 host 文案演进）。
 * 纯函数（可单测）：输入为 settings.update/mutate result.error 的 unknown 形状。
 */
export function isDshSettingsConflict(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const record = error as { code?: unknown; message?: unknown };
	if (typeof record.code === "string" && /settings[-_]conflict/i.test(record.code)) return true;
	return typeof record.message === "string" && record.message.includes("changed since it was read");
}
