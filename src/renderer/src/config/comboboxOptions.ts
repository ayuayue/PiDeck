/**
 * 组合框选项的纯函数工具（可单测）。
 * ConfigComboboxInput（shadcn Popover + Command）与此前的自研 combobox 共用同一套过滤语义：
 * 大小写不敏感，同时匹配 value（落盘值）与 label（展示文本）。
 */

export interface ComboboxOption {
	value: string;
	label?: string;
	/** 分组标题（已翻译）。相邻且相同的 group 归为一段，用于下拉里分段展示。 */
	group?: string;
}

/** 组合框的展示分段：group 为 undefined 的选项归入同一段（无标题）。 */
export interface ComboboxSection<T extends ComboboxOption> {
	group?: string;
	items: T[];
}

/**
 * 按 group 把选项切成相邻分段。
 *
 * 用「相邻合并」而不是「按 group 值分组」：选项数组本身就是期望的展示顺序
 * （如「不写入」置顶、预设按类别排列），按值分组会把顺序重新洗一遍；
 * 相邻合并还能让同一个 group 在过滤后自然连成一段（中间组被筛没了也不留空标题）。
 */
export function groupComboboxOptions<T extends ComboboxOption>(options: T[]): Array<ComboboxSection<T>> {
	const sections: Array<ComboboxSection<T>> = [];
	for (const option of options) {
		const last = sections[sections.length - 1];
		if (last && last.group === option.group) last.items.push(option);
		else sections.push({ group: option.group, items: [option] });
	}
	return sections;
}

/**
 * 按查询词过滤组合框选项。空查询直接返回原数组（不复制，调用方可直接 map）。
 * value 与 label 都参与匹配：label 缺省时用 value 顶替。
 */
export function filterComboboxOptions<T extends ComboboxOption>(options: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return options;
	return options.filter((opt) => opt.value.toLowerCase().includes(q) || (opt.label ?? opt.value).toLowerCase().includes(q));
}

/**
 * 当前值是否命中选项列表。
 * 未命中且值非空时，选择器需要展示「自定义」条目兜底，避免 Radix Select 因
 * value 无匹配 item 而显示为空白（老 settings.json 可能残留枚举外取值）。
 */
export function isKnownComboboxValue<T extends ComboboxOption>(options: T[], value: string): boolean {
	return options.some((opt) => opt.value === value);
}
