import { isRecord, readArray, readFiniteNumber, readString, truncateText } from "./valueRead";

/** 快照归一化：页面返回值一律不可信，先收窄、再截断、最后按预算格式化。 */

export type SnapshotBox = { x: number; y: number; width: number; height: number };

export type SnapshotElement = {
	ref: string;
	role: string;
	name: string;
	tag: string;
	value?: string;
	disabled: boolean;
	box?: SnapshotBox;
};

export type BrowserSnapshot = {
	snapshotId: number;
	url: string;
	title: string;
	viewport: { width: number; height: number };
	scroll: { x: number; y: number };
	devicePixelRatio: number;
	iframeCount: number;
	elements: SnapshotElement[];
	truncated: boolean;
	totalElements: number;
};

export const SNAPSHOT_LIMITS = {
	/** 一次快照最多回给模型的元素数（超出截断并标 truncated）。 */
	maxElements: 200,
	nameChars: 120,
	valueChars: 80,
	/** 整段快照文本预算，避免撑爆上下文。 */
	textChars: 24_000,
} as const;

const REF_PATTERN = /^e\d+$/;

function readBox(raw: unknown): SnapshotBox | null {
	if (!isRecord(raw)) return null;
	const x = readFiniteNumber(raw.x, Number.NaN);
	const y = readFiniteNumber(raw.y, Number.NaN);
	const width = readFiniteNumber(raw.width, Number.NaN);
	const height = readFiniteNumber(raw.height, Number.NaN);
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
	if (width <= 0 || height <= 0) return null;
	return { x, y, width, height };
}

function readSize(raw: unknown): { width: number; height: number } {
	const record = isRecord(raw) ? raw : {};
	return {
		width: Math.max(0, readFiniteNumber(record.width, 0)),
		height: Math.max(0, readFiniteNumber(record.height, 0)),
	};
}

/**
 * 把页面脚本返回值收敛成稳定契约：
 * - 只接受 ref 形如 e1..eN 且不重复的元素（ref 非法直接丢弃，避免模型拿到无法解析的引用）；
 * - 名称/值折叠空白并截断；
 * - 元素数按上限截断，totalElements 保留真实可见数量供模型判断是否要滚动。
 */
export function normalizeBrowserSnapshot(raw: unknown, options: { maxElements?: number } = {}): BrowserSnapshot {
	const maxElements = Math.max(1, Math.min(options.maxElements ?? SNAPSHOT_LIMITS.maxElements, SNAPSHOT_LIMITS.maxElements));
	const record = isRecord(raw) ? raw : {};
	const scroll = isRecord(record.scroll) ? record.scroll : {};
	const elements: SnapshotElement[] = [];
	const seenRefs = new Set<string>();
	const rawElements = readArray(record.elements);
	for (const item of rawElements) {
		if (elements.length >= maxElements) break;
		if (!isRecord(item)) continue;
		const ref = readString(item.ref).trim();
		if (!REF_PATTERN.test(ref) || seenRefs.has(ref)) continue;
		seenRefs.add(ref);
		const element: SnapshotElement = {
			ref,
			role: truncateText(readString(item.role, "element"), 40) || "element",
			name: truncateText(readString(item.name), SNAPSHOT_LIMITS.nameChars),
			tag: truncateText(readString(item.tag, "element"), 24) || "element",
			disabled: item.disabled === true,
		};
		const value = readString(item.value);
		if (value) element.value = truncateText(value, SNAPSHOT_LIMITS.valueChars);
		const box = readBox(item.box);
		if (box) element.box = box;
		elements.push(element);
	}
	// 页面脚本会报真实可见数量；没有时至少用原始条数，保证 maxElements 截断能被识别。
	const totalElements = Math.max(elements.length, Math.floor(readFiniteNumber(record.totalElements, rawElements.length)));
	return {
		snapshotId: 0,
		// url 是页面可控值（SPA 可塞 1MB hash）：不截断会击穿 24KB 文本预算（header 永远保留）。
		url: truncateText(readString(record.url), 500),
		title: truncateText(readString(record.title), 160),
		viewport: readSize(record.viewport),
		scroll: { x: readFiniteNumber(scroll.x, 0), y: readFiniteNumber(scroll.y, 0) },
		devicePixelRatio: readFiniteNumber(record.devicePixelRatio, 1),
		iframeCount: Math.max(0, Math.floor(readFiniteNumber(record.iframeCount, 0))),
		elements,
		truncated: record.truncated === true || totalElements > elements.length,
		totalElements,
	};
}

function escapeQuotes(value: string): string {
	return value.replace(/"/g, "'");
}

/** 模型侧快照文本：一行一个元素，ref 是唯一可寻址句柄。 */
export function formatBrowserSnapshot(snapshot: BrowserSnapshot): string {
	const header = [
		`# browser_snapshot snapshotId=${snapshot.snapshotId}`,
		`target: ${snapshot.url || "about:blank"} | "${escapeQuotes(snapshot.title)}"`,
		`viewport: ${snapshot.viewport.width}x${snapshot.viewport.height} css px | scroll: ${snapshot.scroll.x},${snapshot.scroll.y} | elements: ${snapshot.elements.length}/${snapshot.totalElements} | truncated: ${snapshot.truncated}`,
	];
	const lines = [...header];
	for (const element of snapshot.elements) {
		let line = `- ${element.role} "${escapeQuotes(element.name)}" [ref=${element.ref}]`;
		if (element.value) line += ` value="${escapeQuotes(element.value)}"`;
		if (element.disabled) line += " [disabled]";
		if (element.box) line += ` [box=${Math.round(element.box.x)},${Math.round(element.box.y)},${Math.round(element.box.width)},${Math.round(element.box.height)}]`;
		lines.push(line);
	}
	if (snapshot.elements.length === 0) lines.push("(no interactive elements in the current viewport)");
	let text = lines.join("\n");
	if (text.length > SNAPSHOT_LIMITS.textChars) {
		// 预算兜底：按元素行截断，保留表头（模型仍能看到 URL/视口与真实总数）。
		const kept = [...header];
		for (const line of lines.slice(header.length)) {
			if ([...kept, line].join("\n").length > SNAPSHOT_LIMITS.textChars - 40) break;
			kept.push(line);
		}
		kept.push(`… (truncated by size; showing first ${kept.length - header.length} of ${snapshot.totalElements} elements)`);
		text = kept.join("\n");
	}
	return text;
}
