/**
 * AtomGit 同步的「资产选择」纯规则（可单测）。
 *
 * 从 sync-release-to-atomgit.mjs 拆出来：`--only` 过滤、展示分组、交互输入的解析
 * 都是「这次到底传哪些附件」的规则，放在一起便于单测；调用方只负责 I/O（readline、
 * 网络），把用户输入交给这里的纯函数判定，保证「选择语义」离开终端也能验证。
 *
 * 语义边界：
 * - 过滤/分组只影响「候选集合与展示」，不改变单个资产的默认动作（新增上传、
 *   同名同大小跳过、同名异大小冲突）——那是 planAssetActions 的职责。
 * - 交互输入解析失败一律返回 { error }，调用方必须终止而不是回退成默认计划，
 *   避免「手滑输入」变成「静默全量上传」。
 */

/** 简易 glob（只支持 * 与 ?）→ 正则，用于 `--only` 的资产名匹配。 */
export function globToRegExp(pattern) {
	const escaped = String(pattern)
		// 正则元字符转义（保留 * 与 ? 供下一步替换）
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

/**
 * 按 `--only` 模式过滤资产；未给模式时原样返回（保持既有全量同步行为）。
 * 命中多个模式中任意一个即可。
 */
export function filterAssetsByPatterns(assets, patterns) {
	const list = (patterns ?? []).map((p) => String(p).trim()).filter(Boolean);
	if (list.length === 0) return [...assets];
	const regexps = list.map(globToRegExp);
	return assets.filter((asset) => regexps.some((re) => re.test(String(asset?.name ?? ""))));
}

/** 展示用体积（选择器表格里对齐用）。 */
export function formatAssetSize(bytes) {
	if (!Number.isFinite(bytes)) return "?";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 展示用分类（纯展示，不参与上传决策）。
 * 分类顺序也决定选择器里的排序，让同类资产聚在一起看。
 */
const ASSET_CATEGORIES = [
	["DSH runtime", (name) => /^dsh-runtime-/.test(name)],
	["DSH runner", (name) => /^dsh-runner-node/.test(name)],
	["Node 运行时", (name) => /^node-v?\d/.test(name)],
	["更新索引", (name) => /^latest.*\.yml$/.test(name)],
	["增量更新", (name) => /\.blockmap$/.test(name)],
	["安装包", () => true],
];

export function classifyAsset(name) {
	const text = String(name ?? "");
	for (const [label, match] of ASSET_CATEGORIES) {
		if (match(text)) return label;
	}
	return "其他";
}

/** 分类排序权重（保持 ASSET_CATEGORIES 的声明顺序）。 */
function categoryRank(name) {
	const text = String(name ?? "");
	const index = ASSET_CATEGORIES.findIndex(([, match]) => match(text));
	return index === -1 ? ASSET_CATEGORIES.length : index;
}

/**
 * 组装选择器行：GitHub 资产 + 远端探测结果 + 默认动作。
 *
 * @param assets GitHub 资产（name/size）
 * @param plan planAssetActions 的结果（uploads/skips/conflicts）
 * @returns {Array<{index:number,name:string,size:number,category:string,remote:string,action:'upload'|'skip'|'conflict',reason:string}>}
 *   remote: absent=远端没有 | same-size=同名同大小 | unknown=远端大小探测不到 | mismatch=同名异大小
 */
export function buildAssetSelectionRows(assets, plan) {
	const state = new Map();
	for (const item of plan?.uploads ?? []) state.set(item.name, { action: "upload", reason: item.reason, remote: "absent" });
	for (const item of plan?.skips ?? []) {
		state.set(item.name, {
			action: "skip",
			reason: item.reason,
			remote: item.reason === "same-size" ? "same-size" : "unknown",
		});
	}
	for (const item of plan?.conflicts ?? []) state.set(item.name, { action: "conflict", reason: "size-mismatch", remote: "mismatch" });

	const rows = assets.map((asset) => {
		const info = state.get(asset.name) ?? { action: "upload", reason: "new", remote: "absent" };
		return {
			name: asset.name,
			size: asset.size,
			category: classifyAsset(asset.name),
			action: info.action,
			reason: info.reason,
			remote: info.remote,
		};
	});
	// 同类聚在一起，按名字稳定排序；index 在排序后重排，保证「编号 ↔ 资产」一一对应
	rows.sort((a, b) => categoryRank(a.name) - categoryRank(b.name) || a.name.localeCompare(b.name));
	return rows.map((row, i) => ({ index: i + 1, ...row }));
}

/** 默认动作的中文标签（选择器展示用）。 */
export function actionLabel(row) {
	if (row.action === "skip") {
		return row.reason === "same-size" ? "已存在（大小一致）→ 默认跳过" : "已存在（远端大小未知）→ 默认跳过";
	}
	if (row.action === "conflict") return "⚠️ 同名异大小 → 默认冲突失败";
	return "新增 → 待上传";
}

/**
 * 解析交互输入。
 *
 * 支持：空串（采用默认计划）、`a`/`all`（全选）、`1,3-5`（编号与范围，逗号/空格分隔）。
 * 编号以选择器打印的 1-based 序号为准，去重后按输入顺序返回。
 *
 * @returns {{indices:number[]}|{error:string}} 解析失败返回 error（调用方必须终止，
 *   不能回退默认计划：用户打了字却传了别的东西是最坏的结果）。
 */
export function parseAssetSelection(input, count) {
	const text = String(input ?? "").trim();
	if (text === "") return { indices: [] }; // 空 = 默认计划，由调用方解释
	const lowered = text.toLowerCase();
	if (lowered === "a" || lowered === "all") {
		return { indices: Array.from({ length: count }, (_, i) => i + 1) };
	}
	const indices = [];
	for (const chunk of text.split(/[\s,，]+/).filter(Boolean)) {
		// 支持全角连字符与 en dash（中文输入法下常见）
		const range = chunk.split(/[-–—~]/);
		if (range.length === 1) {
			const value = Number(range[0]);
			if (!Number.isInteger(value) || value < 1 || value > count) {
				return { error: `编号越界或非数字: ${chunk}（有效范围 1-${count}）` };
			}
			if (!indices.includes(value)) indices.push(value);
			continue;
		}
		if (range.length !== 2) return { error: `范围格式错误: ${chunk}` };
		const [from, to] = range.map(Number);
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > count || to > count) {
			return { error: `范围越界或非数字: ${chunk}（有效范围 1-${count}）` };
		}
		if (from > to) return { error: `范围起止颠倒: ${chunk}` };
		for (let i = from; i <= to; i++) if (!indices.includes(i)) indices.push(i);
	}
	if (indices.length === 0) return { error: "没有解析出任何编号" };
	return { indices };
}

/**
 * 按显式选择裁剪行，并标记「点名重传」。
 *
 * 被点名的行若默认动作是 skip（远端同名同大小），必须升级为强制重传——
 * 远端已有同名附件时直接 PUT 会拿到 409，脚本会误以为成功却什么都没换。
 * 冲突行保持冲突语义（是否强改由用户用 --force-upload / --force-resync 明确表态）。
 */
export function selectRows(rows, indices) {
	const chosen = new Set(indices);
	return rows.filter((row) => chosen.has(row.index)).map((row) => (row.action === "skip" ? { ...row, action: "upload", reason: "force-reselect" } : row));
}
