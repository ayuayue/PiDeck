/**
 * 记忆包的导出/导入：对话框与文件 IO 都在主进程，合并语义在
 * `resources/agent-memory/sync.mjs`（与 MCP 服务器共用一份实现，纯函数、可直接单测）。
 *
 * 三个约束：
 * 1. **选包 ≠ 导入**：`previewAgentMemoryBundle` 只读，渲染层拿到条目清单后弹窗勾选；
 *    真正落盘只发生在 `importAgentMemoryBundle`。文件对话框因此只弹一次。
 * 2. **导入前先完整校验**：格式不对就抛，绝不出现「导了一半」的中间态。
 * 3. **导出不打包设备专属记忆**：`devices/` 下的条目描述本机路径与盘符，
 *    拿到另一台机器上是错的（`sync.mjs` 的 `listSharedScopes` 已排除）。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dialog, type BrowserWindow } from "electron";

import { buildExportBundle, mergeBundle, previewBundle, readDeviceProfile, serializeBundle, validateBundle } from "../../../resources/agent-memory/sync.mjs";
import type { AgentMemoryBundlePeekOutcome, AgentMemoryExportOutcome, AgentMemoryImportOptions, AgentMemoryImportResult } from "../../shared/types/agentMemory";

/** 文件名里不能出现的字符（Windows 比 POSIX 严），设备名来自 hostname，必须清洗。 */
function safeFilePart(value: string): string {
	return (
		value
			.replace(/[^\w.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "device"
	);
}

function timestampForFileName(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** 包体积上限：记忆是百量级条目，几十 MB 的「记忆包」一定是选错文件了。 */
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** 读 + 解析 + 校验（预览与导入共用：两处的判断必须一致，否则弹窗承诺的和落盘的不是一回事）。 */
async function readBundleFile(filePath: string): Promise<unknown> {
	const text = await readFile(filePath, "utf8");
	if (text.length > MAX_BUNDLE_BYTES) throw new Error("bundle-too-large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("bundle-invalid");
	}
	validateBundle(parsed);
	return parsed;
}

async function pickBundlePath(getWindow: () => BrowserWindow | null): Promise<string | null> {
	const window = getWindow();
	const options = { title: "导入智能体记忆", properties: ["openFile" as const], filters: [{ name: "PiDeck 记忆包", extensions: ["json"] }] };
	const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
	if (result.canceled || result.filePaths.length === 0) return null;
	return result.filePaths[0];
}

/** 导出：`selection` 为 null/省略 = 全部条目；给了数组就只装这些 id（导出弹窗的勾选）。 */
export async function exportAgentMemoryBundle(input: { root: string; getWindow: () => BrowserWindow | null; now?: Date; selection?: string[] | null }): Promise<AgentMemoryExportOutcome> {
	const now = input.now ?? new Date();
	const device = readDeviceProfile(input.root);
	const window = input.getWindow();
	const options = {
		title: "导出智能体记忆",
		defaultPath: join(process.env.USERPROFILE ?? process.cwd(), `pideck-memory-${safeFilePart(device.name)}-${timestampForFileName(now)}.json`),
		filters: [{ name: "PiDeck 记忆包", extensions: ["json"] }],
	};
	const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
	if (result.canceled || !result.filePath) return { canceled: true };
	const bundle = buildExportBundle(input.root, { exportedAt: now.toISOString(), selection: input.selection ?? null });
	await writeFile(result.filePath, serializeBundle(bundle), "utf8");
	return { canceled: false, path: result.filePath, entries: bundle.entries.length };
}

/** 选包并预览：不写任何文件，也不改记忆；格式非法时抛错（渲染层按错误码提示）。 */
export async function previewAgentMemoryBundle(input: { root: string; getWindow: () => BrowserWindow | null; filePath?: string }): Promise<AgentMemoryBundlePeekOutcome> {
	const filePath = input.filePath ?? (await pickBundlePath(input.getWindow));
	if (!filePath) return { canceled: true };
	const parsed = await readBundleFile(filePath);
	return { canceled: false, filePath, preview: previewBundle(input.root, parsed) };
}

/** 导入：只导入 `selection` 里的条目，冲突按 `conflictPolicy` 处理，墓碑可整体关掉。 */
export async function importAgentMemoryBundle(input: { root: string; getWindow: () => BrowserWindow | null } & AgentMemoryImportOptions): Promise<AgentMemoryImportResult> {
	const filePath = input.filePath ?? (await pickBundlePath(input.getWindow));
	if (!filePath) return { canceled: true, added: 0, duplicate: 0, tombstoned: 0, rejected: 0, removed: 0, replaced: 0, scopes: [], device: "" };
	// 先校验再合并：格式不对时不留任何落盘痕迹。
	const parsed = await readBundleFile(filePath);
	return mergeBundle(input.root, parsed, {
		selection: input.selection ?? null,
		conflictPolicy: input.conflictPolicy === "overwrite" ? "overwrite" : "append",
		applyTombstones: input.applyTombstones !== false,
	});
}
