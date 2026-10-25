/**
 * 项目作用域的「继承全局资源是否已在本项目停用」判定（渲染层纯函数，技能/提示词/扩展三个 tab 共用）。
 *
 * 为什么必须两侧匹配：原生规则里的键**保留原始大小写**（`ProjectResourceManager.toggleInheritedResource`
 * 刻意如此——pi 在 Linux 上按大小写匹配路径，写小写会静默失配），而 Windows 的盘符/家目录常带大写，
 * 同一路径在「规则」与「列表行」之间大小写不一致时，精确匹配会漏判：开关写对了、主进程也生效了，
 * 列表却显示成未停用（看起来像开关弹回）。因此索引同时保留精确集合与折叠大小写集合，
 * 精确命中优先，未命中再走不区分大小写兜底。
 */
export type ProjectOverrideKeyIndex = {
	/** 原样键集合（命中即停用，与 pi 的匹配语义一致） */
	exact: ReadonlySet<string>;
	/** 折叠大小写键集合（跨平台显示兜底：Windows 路径大小写不敏感，Linux 上极少数仅大小写不同的键会被视为同一项） */
	folded: ReadonlySet<string>;
};

/** 由主进程给的停用列表建索引；空值/空串/非字符串一律跳过（渲染层不信任 IPC 数据）。 */
export function buildProjectOverrideKeyIndex(values: readonly string[] | undefined): ProjectOverrideKeyIndex {
	const exact = new Set<string>();
	const folded = new Set<string>();
	for (const value of values ?? []) {
		if (typeof value !== "string") continue;
		const key = value.trim();
		if (!key) continue;
		exact.add(key);
		folded.add(key.toLowerCase());
	}
	return { exact, folded };
}

/** 该资源键是否被本项目停用；key 缺省/空白（无路径无来源）时不判停用。两侧同样 trim，避免索引与查询键的空白差异。 */
export function matchesProjectOverride(index: ProjectOverrideKeyIndex, key: string | undefined): boolean {
	const normalized = key?.trim();
	if (!normalized) return false;
	if (index.exact.has(normalized)) return true;
	return index.folded.has(normalized.toLowerCase());
}
