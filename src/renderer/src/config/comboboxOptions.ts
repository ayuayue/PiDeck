/**
 * 组合框选项的纯函数工具（可单测）。
 * ConfigComboboxInput（shadcn Popover + Command）与此前的自研 combobox 共用同一套过滤语义：
 * 大小写不敏感，同时匹配 value（落盘值）与 label（展示文本）。
 */

export interface ComboboxOption {
	value: string;
	label?: string;
}

/**
 * 按查询词过滤组合框选项。空查询直接返回原数组（不复制，调用方可直接 map）。
 * value 与 label 都参与匹配：label 缺省时用 value 顶替。
 */
export function filterComboboxOptions<T extends ComboboxOption>(
	options: T[],
	query: string,
): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return options;
	return options.filter(
		(opt) =>
			opt.value.toLowerCase().includes(q) ||
			(opt.label ?? opt.value).toLowerCase().includes(q),
	);
}

/**
 * 当前值是否命中选项列表。
 * 未命中且值非空时，选择器需要展示「自定义」条目兜底，避免 Radix Select 因
 * value 无匹配 item 而显示为空白（老 settings.json 可能残留枚举外取值）。
 */
export function isKnownComboboxValue<T extends ComboboxOption>(
	options: T[],
	value: string,
): boolean {
	return options.some((opt) => opt.value === value);
}
