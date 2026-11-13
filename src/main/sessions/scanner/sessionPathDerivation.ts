import type { SessionSummary } from "../../../shared/types";

/** 路径归属推导需要的宿主持有面：本次扫描根与默认根。 */
export type SessionScanRootsHost = {
	/** 最近一次 list() 解析出的扫描根；空数组时退回默认根。 */
	readonly activeScanRoots: readonly string[];
	/** 当前环境（本地 / WSL）下的默认会话根目录。 */
	readonly defaultSessionsRoot: string;
};

/** 找到包含 filePath 的最近（最长路径）扫描根。 */
export function findSessionsRootForFile(host: SessionScanRootsHost, filePath: string): string {
	const normalizedFile = normalizeSessionPath(filePath);
	const roots = host.activeScanRoots.length > 0 ? host.activeScanRoots : [host.defaultSessionsRoot];

	let bestRoot = host.defaultSessionsRoot;
	let bestLen = -1;
	for (const root of roots) {
		const normalizedRoot = normalizeSessionPath(root);
		if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) {
			if (normalizedRoot.length > bestLen) {
				bestRoot = root;
				bestLen = normalizedRoot.length;
			}
		}
	}
	return bestRoot;
}

export function inferProjectPathFromFile(filePath: string): string | undefined {
	const normalized = filePath.replace(/\\/g, "/");
	// 默认布局：~/.pi/agent/sessions/<encoded-cwd>/...
	const marker = "/.pi/agent/sessions/";
	const index = normalized.toLowerCase().indexOf(marker);
	if (index !== -1) {
		const encoded = normalized.slice(index + marker.length).split("/")[0];
		return decodeSessionDirName(encoded);
	}
	// 常见项目级 sessionDir：<project>/.pi/sessions/...
	const customMarker = "/.pi/sessions/";
	const customIndex = normalized.toLowerCase().lastIndexOf(customMarker);
	if (customIndex !== -1) {
		return normalizeSessionPath(normalized.slice(0, customIndex));
	}
	return undefined;
}

export function decodeSessionDirName(encoded: string) {
	// pi 会把 cwd 存成 --C--Users-name-project--（Windows）或 --mnt-c-Users-name-project--（WSL）等目录名；
	// 这里只用于展示和匹配，不写回 session。
	const trimmed = encoded.replace(/^--|--$/g, "");
	// WSL /mnt/ 路径：--mnt-c-Users-...--
	if (trimmed.startsWith("mnt-")) {
		return "/" + trimmed.replace(/-/g, "/");
	}
	// Windows 路径：--C--Users-...--
	const drive = trimmed.match(/^([A-Za-z])--(.+)$/);
	if (drive) return `${drive[1]}:/${drive[2].replace(/-/g, "/")}`.replace(/\//g, "\\");
	// 其他 Linux/WSL 路径
	return trimmed.replace(/-/g, "/");
}

export function isSameProject(host: SessionScanRootsHost, summary: SessionSummary, projectPath: string) {
	const normalizedProject = normalizeSessionPath(projectPath);
	const normalizedSessionProject = summary.projectPath ? normalizeSessionPath(summary.projectPath) : "";
	if (normalizedSessionProject === normalizedProject) return true;
	// 列表扫描禁止读 JSONL 正文做父目录归属。早期「在 home 启动再进子项目」的会话，
	// 若路径编码的是父目录，侧栏可能暂时不显示；已入册条目仍走 catalog 缓存。

	// 项目级自定义 sessionDir（如 <project>/.pi/sessions）下的文件默认归属该项目。
	// 该布局不再使用 encoded-cwd 子目录，safePathToken 无法从路径反推项目。
	if (isUnderProjectSessionDir(host, summary.filePath, projectPath)) return true;

	return normalizeSessionPath(summary.filePath).includes(sessionPathToken(projectPath));
}

/**
 * 判断会话文件是否位于项目的自定义 sessionDir 扫描根下。
 * activeScanRoots 中除默认全局根外的目录即配置的 sessionDir。
 */
export function isUnderProjectSessionDir(host: SessionScanRootsHost, filePath: string, projectPath: string): boolean {
	const normalizedFile = normalizeSessionPath(filePath);
	const defaultRoot = normalizeSessionPath(host.defaultSessionsRoot);
	const normalizedProject = normalizeSessionPath(projectPath);
	for (const root of host.activeScanRoots) {
		const normalizedRoot = normalizeSessionPath(root);
		if (normalizedRoot === defaultRoot) continue;
		if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) {
			// 相对 sessionDir 通常落在项目目录内；绝对共享目录仍靠 cwd 过滤。
			if (normalizedRoot === normalizedProject || normalizedRoot.startsWith(`${normalizedProject}/`)) {
				return true;
			}
		}
	}
	return false;
}

/** 路径比「sessions 根下的单层 jsonl」更深，才值得做父会话探测。 */
export function looksLikeNestedSessionPath(host: SessionScanRootsHost, filePath: string): boolean {
	const normalized = normalizeSessionPath(filePath);
	const root = normalizeSessionPath(findSessionsRootForFile(host, filePath));
	if (!normalized.startsWith(`${root}/`)) return false;
	const relative = normalized.slice(root.length + 1);
	return relative.split("/").length > 2;
}

export function canonicalSessionPath(path: string, wsl: boolean) {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return wsl ? normalized : normalized.toLowerCase();
}

export function normalizeSessionPath(path: string) {
	return canonicalSessionPath(path, false);
}

export function sessionPathToken(path: string) {
	const normalized = path.replace(/\\/g, "/");
	// 盘符根（D:\）也要命中本分支：(.+) 时盘根落到 fallback 产出含 ":" 的非法目录名，导入必败
	const win = normalized.match(/^([A-Za-z]):\/(.*)$/);
	if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`.toLowerCase();
	return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`.toLowerCase();
}
