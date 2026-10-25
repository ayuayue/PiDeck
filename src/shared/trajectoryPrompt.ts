import type { SessionPromptSnapshot } from "./types/trajectory";

/**
 * 轨迹提示词快照的共享规则（两后端同一口径）。
 *
 * 为什么放 shared：pi 读会话文件重放、dsh 折叠事件流，两条采集链路各自独立，
 * 但「回传文本上界」与「事件摘要文字」必须一致，否则同一功能在两个后端表现不同。
 */

/**
 * 单份快照回传提示词文本的字符上限。
 * 实测：pi 系统提示 10–33KB（sections 展开），dsh harness 组装后 54–58KB；
 * 取 96k 覆盖两者并留余量，超限截断并标记 truncated（账本只保证可读，不保证全文）。
 */
export const MAX_TRAJECTORY_PROMPT_CHARS = 96_000;

/**
 * 单份快照回传提示词文本的 UTF-8 字节上限（256KiB）。
 *
 * 为什么字符上限不够：`length` 是 UTF-16 码元数，CJK 一个字占 3 字节。
 * 96,000 个汉字 = 288,000 字节，是 288KiB——只按字符截断会把单条 IPC 载荷放大到
 * 近 300KB，多份快照叠加后手机（或低配机）渲染与传输成本失控。
 * 256KiB = 262,144 字节 < 288,000，因此这条约束**能独立生效**（汉字、emoji 都会先撞它）。
 */
export const MAX_TRAJECTORY_PROMPT_BYTES = 262_144;

/**
 * 按双上限裁剪提示词文本，且只在完整 Unicode 码点边界切。
 *
 * 不能直接 `slice(0, MAX_CHARS)`：代理对（emoji）会被切成半个高代理，
 * 渲染层拿到的是 U+FFFD 或乱码；字节切分同理。
 */
export function truncatePromptText(text: string): { text: string; truncated: boolean } {
	let units = 0;
	let bytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index) ?? 0;
		const width = codePoint > 0xffff ? 2 : 1;
		const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
		if (units + width > MAX_TRAJECTORY_PROMPT_CHARS || bytes + size > MAX_TRAJECTORY_PROMPT_BYTES) break;
		units += width;
		bytes += size;
		index += width;
	}
	return index >= text.length ? { text, truncated: false } : { text: text.slice(0, index), truncated: true };
}

/** 工具名清单上限：正常会话 ≤ 30，异常数据不拖垮 IPC。 */
export const MAX_TRAJECTORY_PROMPT_TOOLS = 200;

/**
 * 快照摘要（主进程只写事实，用户可见文案由渲染层按 i18n 生成）：
 * 例 `initial prompt · 21450 chars · 14 tools`、`update · sections ~rules · tools +write`。
 */
export function promptSnapshotSummary(snapshot: SessionPromptSnapshot): string {
	const head = `${snapshot.kind} · ${snapshot.text.length} chars · ${snapshot.tools.length} tools`;
	if (snapshot.kind === "initial") return head;
	const parts: string[] = [];
	if (snapshot.sectionsAdded?.length) parts.push(`sections +${snapshot.sectionsAdded.join(",")}`);
	if (snapshot.sectionsUpdated?.length) parts.push(`sections ~${snapshot.sectionsUpdated.join(",")}`);
	if (snapshot.sectionsRemoved?.length) parts.push(`sections -${snapshot.sectionsRemoved.join(",")}`);
	if (snapshot.toolsAdded?.length) parts.push(`tools +${snapshot.toolsAdded.join(",")}`);
	if (snapshot.toolsRemoved?.length) parts.push(`tools -${snapshot.toolsRemoved.join(",")}`);
	return parts.length === 0 ? head : `${head} · ${parts.join(" · ")}`;
}
