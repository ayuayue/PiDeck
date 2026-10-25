/**
 * DSH settings schema 渲染辅助：把 schemastery Schema JSON（settings.describe
 * 返回的 schema 字段）折叠成可渲染的字段树，供配置管理页表单使用。
 *
 * schema 形状（探针实测）：
 * { uid: <rootRefId>, refs: { <id>: { type, meta, dict?, inner?, list?, value? } } }
 * - object：dict = { 字段名 → refId }（固定字段）
 * - dict：inner = 值 refId（动态键，如 llm-pi-ai.providers）
 * - union：list = refId[]
 * - const：value = 固定值
 * - array：inner = 元素 refId
 * - string/number/boolean：meta 携带 default/min/max/role(secret|credential-ref)
 */

import { deepEqual } from "../utils/deepEqual";

export type DshSchemaRef = {
	type: string;
	meta?: Record<string, unknown>;
	dict?: Record<string, number>;
	inner?: number;
	list?: number[];
	value?: unknown;
};

export type DshSchema = {
	uid: number;
	refs: Record<number, DshSchemaRef>;
};

/** 子分区统一保存/脏状态接口（与 Pi 管理页同一模式：顶部保存 + 关闭确认）。 */
export type DshSectionApi = {
	/** 上报本实例是否有未保存修改（DshConfigTab 汇总 → ConfigModal 顶部黄点/关闭确认）。 */
	onDirtyChange: (instanceId: string, dirty: boolean) => void;
	/** 注册本实例的保存函数（顶部保存按钮统一调用）。 */
	registerSave: (instanceId: string, save: () => Promise<boolean>) => void;
	/** 卸载时注销保存函数。 */
	unregisterSave: (instanceId: string) => void;
};

/** 归一化 schema：兼容 refs 键是 number 或 string。 */
export function normalizeDshSchema(raw: unknown): DshSchema | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as { uid?: unknown; refs?: unknown };
	if (typeof value.uid !== "number" || !value.refs || typeof value.refs !== "object") return null;
	const refs: Record<number, DshSchemaRef> = {};
	for (const [key, ref] of Object.entries(value.refs as Record<string, unknown>)) {
		if (!ref || typeof ref !== "object") continue;
		const typed = ref as DshSchemaRef;
		const id = Number(key);
		refs[id] = {
			type: typeof typed.type === "string" ? typed.type : "unknown",
			meta: typed.meta,
			dict: typed.dict,
			inner: typed.inner,
			list: typed.list,
			value: typed.value,
		};
	}
	return { uid: value.uid, refs };
}

export type DshSchemaField = {
	/** 字段名（object.dict 的键 / 动态 dict 的 entry key）。 */
	name: string;
	ref: DshSchemaRef;
	/** 是否是动态 dict 的条目（providers.xxx）。 */
	dictEntry?: boolean;
};

/** object.dict 固定字段列表（保持 schema 声明顺序）。 */
export function objectFields(schema: DshSchema, ref: DshSchemaRef): DshSchemaField[] {
	if (ref.type !== "object" || !ref.dict) return [];
	return Object.entries(ref.dict).map(([name, refId]) => ({
		name,
		ref: schema.refs[refId] ?? { type: "unknown" },
	}));
}

/** union 的可选 const 值列表（供下拉选择；非 const 分支返回空）。 */
export function unionConstOptions(schema: DshSchema, ref: DshSchemaRef): Array<{ value: string; label: string }> {
	if (ref.type !== "union" || !ref.list) return [];
	const options: Array<{ value: string; label: string }> = [];
	for (const refId of ref.list) {
		const branch = schema.refs[refId];
		if (branch?.type === "const" && typeof branch.value === "string") {
			options.push({ value: branch.value, label: branch.value });
		}
	}
	return options;
}

/** 当前值里动态 dict 的条目列表（llm-pi-ai.providers → 各 provider key）。 */
export function dictEntries(value: unknown): Array<{ key: string; value: unknown }> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value as Record<string, unknown>).map(([key, item]) => ({
		key,
		value: item,
	}));
}

/** secret 槽位是否已配置（secrets 列表里 path 匹配）。 */
export function isSecretSet(secrets: Array<{ path: string[]; set: boolean }>, path: string[]): boolean {
	return secrets.some((secret) => secret.set && secret.path.length === path.length && secret.path.every((segment, index) => segment === path[index]));
}

/** 从 schema 收集所有 credential-ref 字段的 env 名（认证 tab 用）。 */
export function collectCredentialRefs(schema: DshSchema, ref: DshSchemaRef, out: Set<string>): void {
	const meta = ref.meta ?? {};
	if (meta.role === "credential-ref" && typeof meta.default === "string") {
		out.add(meta.default);
		return;
	}
	if (ref.type === "object" && ref.dict) {
		for (const refId of Object.values(ref.dict)) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefs(schema, child, out);
		}
		return;
	}
	if ((ref.type === "dict" || ref.type === "array") && ref.inner) {
		const child = schema.refs[ref.inner];
		if (child) collectCredentialRefs(schema, child, out);
		return;
	}
	if (ref.type === "union" && ref.list) {
		for (const refId of ref.list) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefs(schema, child, out);
		}
	}
}

/**
 * 收集 credential-ref 槽位的 env 名（认证 tab 用），覆盖两类来源：
 * - schema 静态 default：如 llm-deepseek.apiKeyEnv（default="DEEPSEEK_API_KEY"）；
 * - 用户配置的动态值：如 llm-pi-ai.providers[*].apiKeyEnv 的 schema 只有 role 标注、
 *   没有 default，env 名存在 value 里——不读 value 会漏掉用户已配置的凭证。
 */
export function collectCredentialRefsWithValue(schema: DshSchema, ref: DshSchemaRef, value: unknown, out: Set<string>): void {
	const meta = ref.meta ?? {};
	if (meta.role === "credential-ref") {
		if (typeof meta.default === "string" && meta.default) out.add(meta.default);
		if (typeof value === "string" && value.trim()) out.add(value.trim());
		return;
	}
	if (ref.type === "object" && ref.dict) {
		for (const [name, refId] of Object.entries(ref.dict)) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefsWithValue(schema, child, readPath(value, [name]), out);
		}
		return;
	}
	if ((ref.type === "dict" || ref.type === "array") && ref.inner) {
		const child = schema.refs[ref.inner];
		if (!child) return;
		// dict 的 value 是 { key → 条目 }，array 的 value 是条目数组，遍历条目继续下钻
		if (Array.isArray(value)) {
			for (const item of value) collectCredentialRefsWithValue(schema, child, item, out);
		} else if (value && typeof value === "object") {
			for (const item of Object.values(value as Record<string, unknown>)) {
				collectCredentialRefsWithValue(schema, child, item, out);
			}
		}
		return;
	}
	if (ref.type === "union" && ref.list) {
		for (const refId of ref.list) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefsWithValue(schema, child, value, out);
		}
	}
}

/**
 * 表单草稿覆盖读取：路径在草稿里（含空串）即用草稿值，否则回退已保存值。
 *
 * 空串必须视为「用户显式清空」而不是「未覆盖」——若草稿读值在这里吞掉空串，
 * 用户删掉输入后输入框会立刻弹回已保存值（清不掉的经典体验）。
 */
export function readDshDraftValue(draft: unknown, saved: unknown, path: string[]): unknown {
	const overridden = readPath(draft, path);
	return overridden !== undefined ? overridden : readPath(saved, path);
}

/**
 * 草稿相对已保存值是否有实际改动：沿草稿叶子路径逐点与已保存值比较。
 *
 * 与「值等于已保存就删除覆盖」策略不同：覆盖始终保留在草稿里，输入框显示就恒等于用户的
 * 输入（逐字符变化时不会因为打到与已存值相等就跳回/清空）；脏状态只由「草稿 != 已保存」
 * 的叶子决定，构造中的 "max" 不会被当作「改回原值」打断。
 */
export function hasDshDraftChanges(draft: Record<string, unknown>, saved: unknown): boolean {
	const leaves: Array<{ path: string[]; value: unknown }> = [];
	const walk = (node: unknown, path: string[]): void => {
		if (node && typeof node === "object" && !Array.isArray(node)) {
			const entries = Object.entries(node as Record<string, unknown>);
			// 空对象视为无编辑（草稿不会产生「编辑成空对象」的叶子）
			if (entries.length === 0) return;
			for (const [key, value] of entries) walk(value, [...path, key]);
			return;
		}
		leaves.push({ path, value: node });
	};
	walk(draft, []);
	return leaves.some((leaf) => !deepEqual(leaf.value, readPath(saved, leaf.path)));
}

/**
 * number 字段草稿的保存前归一化：草稿里的原始字符串转回数值。
 *
 * 数字输入框在编辑中间态（如 "5e"、清空）会给非数字字符串，若草稿直接存字符串，
 * 提交的 patch 会带 string 而 host schema 是 number。这里按 schema 叶子类型转换：
 * - number 叶子：trim 后为空/非法 → 返回 undefined（patch 删除该键，host 保持已保存值）；
 * - object/dict/array：按字段/元素递归，容器叶子之外原样保留。
 */
export function normalizeDshNumberDraft(schema: DshSchema, ref: DshSchemaRef, draft: unknown): unknown {
	if (ref.type === "number" && typeof draft === "string") {
		const trimmed = draft.trim();
		if (trimmed === "") return undefined;
		const next = Number(trimmed);
		return Number.isFinite(next) ? next : undefined;
	}
	if (ref.type === "object" && ref.dict && draft && typeof draft === "object" && !Array.isArray(draft)) {
		const next: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(draft as Record<string, unknown>)) {
			const fieldRef = schema.refs[ref.dict[key]];
			const cleaned = fieldRef ? normalizeDshNumberDraft(schema, fieldRef, value) : value;
			if (cleaned !== undefined) next[key] = cleaned;
		}
		return next;
	}
	if ((ref.type === "dict" || ref.type === "array") && ref.inner && draft && typeof draft === "object") {
		const inner = schema.refs[ref.inner];
		if (inner) {
			if (Array.isArray(draft)) {
				return draft.map((item) => normalizeDshNumberDraft(schema, inner, item) ?? item);
			}
			const next: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(draft as Record<string, unknown>)) {
				const cleaned = normalizeDshNumberDraft(schema, inner, value);
				if (cleaned !== undefined) next[key] = cleaned;
			}
			return next;
		}
	}
	return draft;
}

/** 读取 path 下的当前值（未设置返回 undefined）。 */
export function readPath(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const segment of path) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * 读取 llm-pi-ai provider 条目字段：草稿优先，草稿缺失时回退已保存值。
 *
 * 不能只沿草稿路径逐段取：新增 provider / 编辑 models 后草稿里往往只有部分字段，
 * 如果中途遇到 undefined 就返回，会把已保存的 baseURL/api/displayName 全部“吞掉”。
 */
export function readDshEntryValue(draft: unknown, saved: unknown, key: string, path: string[]): unknown {
	const draftValue = readPath(draft, ["providers", key, ...path]);
	if (draftValue !== undefined) return draftValue;
	return readPath(saved, ["providers", key, ...path]);
}

/** 写入 path 下的值（创建中间对象；用于 patch 构造）。 */
export function setPath(root: Record<string, unknown>, path: string[], value: unknown): void {
	let current = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const segment = path[index];
		const existing = current[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[path[path.length - 1]] = value;
}

/**
 * 删除 patch 里 path 指向的叶子字段，并自底向上清掉变成空对象的父节点。
 * 用于「改回原值 / 清空输入」时移除覆盖：setPath(root, path, undefined) 会留下
 * undefined 键导致 Object.keys 仍算脏，这里彻底删键，脏标记才能正确消失。
 */
export function deletePath(root: Record<string, unknown>, path: string[]): void {
	if (path.length === 0) return;
	const chain: Array<[Record<string, unknown>, string]> = [];
	let current = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const segment = path[index];
		const existing = current[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) return;
		chain.push([current, segment]);
		current = existing as Record<string, unknown>;
	}
	delete current[path[path.length - 1]];
	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const [parent, key] = chain[index];
		const child = parent[key];
		if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
			delete parent[key];
		} else {
			break;
		}
	}
}

/** DSH 省略 retryPolicy 时的默认次数：normal mode、瞬时错误最多再试 5 次。 */
export const DSH_DEFAULT_RETRY_MAX = 5;

export type DshRetryPolicyView = {
	mode: "normal" | "always";
	maxRetries?: number;
	backoff?: Record<string, unknown>;
};

/**
 * 读供应商 retryPolicy。DSH 没有全局重试次数：策略挂在 llm-deepseek /
 * llm-pi-ai.providers.<id>.retryPolicy。省略 = normal + 5 次。
 */
export function readDshRetryPolicy(value: unknown): DshRetryPolicyView {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { mode: "normal" };
	}
	const rec = value as Record<string, unknown>;
	const mode = rec.mode === "always" ? "always" : "normal";
	const maxRetries = typeof rec.maxRetries === "number" && Number.isFinite(rec.maxRetries) && rec.maxRetries >= 0 ? rec.maxRetries : undefined;
	const backoff = rec.backoff && typeof rec.backoff === "object" && !Array.isArray(rec.backoff) ? (rec.backoff as Record<string, unknown>) : undefined;
	return { mode, ...(maxRetries !== undefined ? { maxRetries } : {}), ...(backoff ? { backoff } : {}) };
}

/**
 * 把用户填的次数写成 retryPolicy patch。
 * 空值：always 保持无限；normal 写成默认 5 次（settings.update 是合并，省略字段删不掉已有策略）。
 * 填了次数：写成 mode=normal（always 改为有限次数，避免无限打供应商）。
 */
export function patchDshRetryMaxRetries(existing: unknown, maxRetries: number | undefined): unknown {
	const current = readDshRetryPolicy(existing);
	if (maxRetries === undefined) {
		if (current.mode === "always") return existing ?? { mode: "always" };
		const next: Record<string, unknown> = { mode: "normal", maxRetries: DSH_DEFAULT_RETRY_MAX };
		if (current.backoff) next.backoff = current.backoff;
		return next;
	}
	const next: Record<string, unknown> = { mode: "normal", maxRetries };
	if (current.backoff) next.backoff = current.backoff;
	return next;
}

/** 从嵌套值里移除空对象（patch 提交前清理）。 */
export function pruneEmptyObjects(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(pruneEmptyObjects);
	if (!value || typeof value !== "object") return value;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const cleaned = pruneEmptyObjects(item);
		if (cleaned !== undefined && !(typeof cleaned === "object" && cleaned !== null && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0)) {
			next[key] = cleaned;
		}
	}
	return next;
}
