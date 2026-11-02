/** `sync.mjs` 的类型声明（导出/导入：多设备共用记忆）。 */

export const BUNDLE_FORMAT: string;
export const BUNDLE_VERSION: number;

export interface BundleDevice {
	id: string;
	name: string;
}

export interface BundleEntry {
	target: "memory" | "user" | "standing" | "failure";
	scope: "global" | "project";
	projectKey: string;
	content: string;
	category?: string;
}

export interface BundleTombstone {
	key: string;
	target: string;
	scope: string;
	projectKey: string;
	at: string;
}

export interface MemoryBundle {
	format: string;
	version: number;
	exportedAt: string;
	device: BundleDevice;
	entries: BundleEntry[];
	tombstones: BundleTombstone[];
}

export interface MergeOutcome {
	added: number;
	duplicate: number;
	tombstoned: number;
	rejected: number;
	removed: number;
	/** 同首行冲突被包内版本替换掉的条数（`conflictPolicy: "overwrite"` 才有）。 */
	replaced: number;
	scopes: string[];
	device: string;
}

/** 包内条目在本机的处境：新增 / 已存在 / 同首行的另一个版本 / 本地删过 / 拒收。 */
export type BundleEntryStatus = "new" | "duplicate" | "conflict" | "tombstoned" | "invalid";

export interface BundlePreviewEntry {
	/** 跨机器身份（`目标|作用域|作用域键|归一化内容`）；`invalid` 条目为空串。 */
	id: string;
	target: string;
	scope: string;
	projectId: string;
	content: string;
	category: string;
	status: BundleEntryStatus;
	/** `invalid` 条目的原因码（`device-scope` / `unsafe-content` / `entry-invalid` …）。 */
	reason: string;
	/** 本地对应的那条：`duplicate` 是同一条原文，`conflict` 是待替换的旧版本。 */
	localContent: string;
}

export interface BundlePreviewTombstone {
	target: string;
	projectId: string;
	at: string;
	/** 本地还留着的同一条内容；空串表示本地已经没有了。 */
	localContent: string;
}

export interface BundlePreview {
	format: string;
	version: number;
	exportedAt: string;
	device: string;
	entries: BundlePreviewEntry[];
	counts: { total: number; new: number; duplicate: number; conflict: number; tombstoned: number; invalid: number };
	tombstones: BundlePreviewTombstone[];
	scopes: string[];
}

export function readDeviceProfile(root: string): BundleDevice;
export function renameDevice(root: string, name: string): BundleDevice;
export function deviceScopeId(root: string): string;
export function readTombstones(root: string): BundleTombstone[];
export function addTombstone(root: string, input: { target: string; scope: string; projectKey?: string; content: string; at?: string }): void;
export function removeTombstone(root: string, input: { target: string; scope: string; projectKey?: string; content: string }): void;
export function listSharedScopes(root: string): { target: string; scope: string; projectId: string }[];
export function buildExportBundle(root: string, options?: { exportedAt?: string; selection?: string[] | null }): MemoryBundle;
export function serializeBundle(bundle: MemoryBundle): string;
export function validateBundle(value: unknown): MemoryBundle;
export function mergeBundle(
	root: string,
	value: unknown,
	options?: { selection?: string[] | null; conflictPolicy?: "append" | "overwrite"; applyTombstones?: boolean; localDeviceKey?: string },
): MergeOutcome;
/** 条目的跨机器身份；导出/导入弹窗的勾选就用它。 */
export function exportEntryId(input: { target: string; scope: string; projectKey?: string; content: string }): string;
/** 只读预览：导入弹窗据此决定默认勾选与冲突提示。 */
export function previewBundle(root: string, value: unknown, options?: { localDeviceKey?: string }): BundlePreview;
export function countBundleEntries(value: unknown): { entries: number; device: string; exportedAt: string };
