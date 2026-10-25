/**
 * AI 回复中裸文件路径的「识别 + 解析」纯函数模块（零依赖，可被 node:test 直接导入）。
 *
 * 背景：remarkLinkifyPaths 把回复里的裸路径渲染成 file:// 链接，但模型提到的
 * 路径经常不存在（幻觉、跨项目绝对路径、文件已删/已移动），点击后主进程
 * ENOENT 返回空串 → 编辑器一片空白。参考 VS Code Copilot Chat 的
 * filePathLinkifier 做法（候选先 stat 校验、存在才保留链接、否则维持纯文本），
 * 渲染侧与校验侧共用同一份匹配/解析逻辑，保证「所见链接」=「校验对象」=
 * 「点击打开的路径」。
 *
 * 识别边界（issue #229）：目录与无扩展名文件（`src/main/ipc`、`Makefile`、`.gitignore`）
 * 也参与识别——识别只是「候选」，存在性由 verdict store 静默校验，误报会降级成纯文本。
 * 刻意不识别：单段无扩展名普通词（`components`）、1 层相对路径（`src/main`，与 `and/or`、
 * `N/A` 无法区分）、斜杠列表（`A/B/C/`、`他/她/`、中文散文里的 `降分辨率/抽帧`，
 * 判据见 isTrailingSlashDirCandidate）。
 */

/** 裸文件路径识别正则：
 * - 前缀支持盘符（大小写）、~ 家目录缩写、./ …、POSIX 根与「段段/」形式
 * - 排除空白 + ASCII 标点 + 全角标点/符号（，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／）
 * - 排除全角区（\u{FF00}-\u{FFEF}）、连字符/破折号区（\u{2010}-\u{2027}）、
 *   一般标点区（\u{2030}-\u{205E}）——避免 "src/a.ts，" 把全角逗号吞进路径
 * - 目录段与扩展名支持 Unicode 字母（中文/日文文件名）
 */
export const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|(?:\.\.?[\\/]|[\\/])|(?:[\p{L}_][\p{L}\p{N}_.-]*[\\/])+)[^\s<>"'`|?*\[\](){}，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／\u{FF00}-\u{FFEF}\u{2010}-\u{2027}\u{2030}-\u{205E}]+\.[\p{L}\p{N}]+/gu;

/** 完整 URL（含 scheme 的任意协议）。打码用，只认形态不验证协议合法性。 */
const URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/g;

export interface PlainFilePathMatch {
	path: string;
	start: number;
	end: number;
}

/** 目录段：与 FILE_PATH_RE 的前缀段同一口径（首字符必须是字母/下划线，避免 `24/7`、`2024/01` 被当成路径）。 */
const DIR_SEGMENT = "[\\p{L}_][\\p{L}\\p{N}_.-]*";
/** 目录候选的末段：只认 ASCII 字母/数字/下划线/连字符。
 *  中文词紧贴斜杠时（模型常写 `src/main/和 utils/`，斜杠后不空格）与中文目录名无法用正则区分；
 *  而中文目录名通常带扩展名或尾斜杠（分别由 FILE_PATH_RE / TRAILING_SLASH_DIR_RE 覆盖），
 *  因此末段收窄到 ASCII 是这里唯一可靠的判据。 */
const DIR_LAST_SEGMENT = "[A-Za-z_][A-Za-z0-9_-]*";
/** 尾随边界：后面还有路径字符或分隔符，说明这是更长路径的前缀，不能当独立候选
 *  （`C:\proj\src\a.ts` 必须留给 FILE_PATH_RE，不能被目录规则截成 `C:\proj\src\a`）。 */
const PATH_TAIL_BOUNDARY = "(?![\\p{L}\\p{N}_.\\-\\\\/])";
/** 强前缀（与 FILE_PATH_RE 同一组形态）：盘符 / 家目录 / 绝对 / `./`、`../` 相对。 */
const DIR_STRONG_PREFIX = "(?:[A-Za-z]:[\\\\/]|~[\\\\/]|(?:\\.\\.?[\\\\/]|[\\\\/]))";
/** 强前缀开头的路径（可 0 段或多段）：`C:\proj\`、`~/dev/`、`/usr/local/`、`./src/`。 */
const DIR_STRONG_START = DIR_STRONG_PREFIX + "(?:" + DIR_SEGMENT + "[\\\\/])*";
/** 深路径起点（含无后缀目录规则）：相对形式要求 ≥2 段，否则 `and/or` 会被当成 `and/` + `or`。 */
const DIR_DEEP_START = "(?:" + DIR_STRONG_START + "|(?:" + DIR_SEGMENT + "[\\\\/]){2,})";

/** 起点边界：前面还粘着单词/路径字符说明这是更长 token 的尾巴（`and/or` 里的 `/or`、`xMakefile`）。 */
const PATH_HEAD_BOUNDARY = "(?<![\\p{L}\\p{N}_.\\-\\\\/])";

/**
 * 尾斜杠目录：`src/main/`、`docs/`、`C:\proj\`、`~/dev/`。
 * 正则里的 `(?![A-Za-z0-9])` 只排除「斜杠后还有 ASCII 字母数字」的英文散文
 * （`and/or`、`TCP/IP`、`he/she`）——这种位置不可能是路径收尾。
 * 中文散文（`降分辨率/抽帧`）与目录引用局部同形，正则无法区分，
 * 候选统一再过 isTrailingSlashDirCandidate 的收尾字符 + 段构成判据。
 */
const TRAILING_SLASH_DIR_RE = new RegExp(PATH_HEAD_BOUNDARY + "(?:" + DIR_STRONG_START + "|(?:" + DIR_SEGMENT + "[\\\\/])+)(?![A-Za-z0-9])", "gu");

/**
 * 无扩展名目录（可出现在绝对路径或 2 层以上的相对路径）：`src/renderer/src/components`、
 * `C:\proj\src`、`/usr/local`、`~/dev/proj`。相对路径要求 ≥2 个斜杠，因为 `and/or`、`N/A`、
 * `TCP/IP`、`CI/CD` 这类斜杠列表与 1 层相对路径无法区分——宁可漏掉 `src/main`，不可误报。
 */
const BARE_DIR_RE = new RegExp(PATH_HEAD_BOUNDARY + DIR_DEEP_START + DIR_LAST_SEGMENT + PATH_TAIL_BOUNDARY, "gu");

/**
 * 无扩展名文件的封闭白名单 + 点开头配置文件。
 * 单段无扩展名的普通单词（`components`、`docs`）绝不能识别——与英文单词无法区分；
 * 只有这些「整个文件名的确可以是无扩展名」的固定名字才有资格进白名单。
 */
const NAMELESS_FILE_NAMES = [
	"Makefile",
	"GNUmakefile",
	"Dockerfile",
	"Containerfile",
	"Jenkinsfile",
	"Justfile",
	"Gemfile",
	"Rakefile",
	"Brewfile",
	"Caddyfile",
	"Vagrantfile",
	"Procfile",
	"LICENSE",
	"LICENCE",
	"COPYING",
	"NOTICE",
	"README",
	"CHANGELOG",
	"CONTRIBUTING",
	"AUTHORS",
	"CODEOWNERS",
	"\\.gitignore",
	"\\.gitattributes",
	"\\.gitmodules",
	"\\.gitkeep",
	"\\.mailmap",
	"\\.editorconfig",
	"\\.npmrc",
	"\\.nvmrc",
	"\\.node-version",
	"\\.prettierrc",
	"\\.prettierignore",
	"\\.eslintignore",
	"\\.dockerignore",
	"\\.babelrc",
	"\\.env",
	"\\.envrc",
	"\\.htaccess",
	"\\.bashrc",
	"\\.zshrc",
	"\\.profile",
	"\\.vimrc",
	"\\.ignore",
];

/**
 * 白名单名字（可带目录前缀）：`Makefile`、`docs/Makefile`、`a/.gitignore`。
 * 前后都有边界，`xMakefile`、`Makefile.bak`、`a.env` 一律不命中。
 */
const NAMELESS_FILE_RE = new RegExp(`(?<![\\p{L}\\p{N}_.\\-\\\\/])` + `(?:[A-Za-z]:[\\\\/]|~[\\\\/]|(?:\\.\\.?[\\\\/]|[\\\\/])|(?:${DIR_SEGMENT}[\\\\/])+)?` + `(?:${NAMELESS_FILE_NAMES.join("|")})${PATH_TAIL_BOUNDARY}`, "giu");

/**
 * 尾斜杠目录候选的保守过滤：`A/B/C/`、`他/她/`、`24/7/` 这类短段斜杠列表与目录无法靠正则区分，
 * 要求至少一个段长度 ≥2（盘符不算段）。
 */
function hasPlausibleSegment(match: string): boolean {
	const withoutDrive = match.replace(/^[A-Za-z]:[\\/]/, "");
	return withoutDrive.split(/[\\/]+/).some((segment) => segment.length >= 2);
}

/** 强前缀形态判定（与 DIR_STRONG_PREFIX 同一组：盘符 / 家目录 / 绝对 / `./`、`../`）。 */
const DIR_STRONG_PREFIX_RE = new RegExp("^(?:" + DIR_STRONG_PREFIX + ")");
/** 目录引用正常收尾的字符：空白 + 分隔/收尾标点。开启式标点（`（【《「`）不算——
 *  路径后面不会紧跟一个「新短语的开头」，`GDPR/《个保法》` 的斜杠是并列分隔符。 */
const DIR_TRAILING_BOUNDARY_RE = /[\s，。；：！？、）》】」』”’…,.;:!?)\]}]/;
/** 中文/日文/韩文字母：斜杠后紧跟这些字符 = 候选被粘在中文正文里（模型常写 `src/main/和 utils/`）。 */
const CJK_LETTER_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 纯 ASCII 路径段：字母/数字/下划线/点/连字符。 */
const ASCII_PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * 尾斜杠候选验收（线上回归：中文散文被误识别 → 存在性判否 → 正文中间变灰字）。
 *
 * 尾斜杠是「目录」的强信号，但中文里 `降分辨率/抽帧`、`交通流量/车速/违章` 与目录引用
 * 局部同形，正则无法区分，只能按「收尾字符 + 段构成」补判据：
 * - 强前缀（`C:\`、`~/`、`/`、`./`）：形态已唯一，直接认；
 * - 相对候选至少含一个 ASCII 段：纯中文段 + 斜杠几乎全是 `A/B` 式并列
 *   （`降分辨率/抽帧`、`人群/车牌/`），宁可漏掉裸相对的中文目录名；
 * - 尾斜杠后紧跟中文正文：只有「≥2 段且首段是 ASCII」才认——代码根开头的
 *   `src/main/和 utils/`、`src/中文目录/里的文件` 成立；散文并列词的首段是中文
 *   （`主动补证/时间窗/采样帧数/ROI/重复推理`、`降分辨率/抽帧`）不成立；
 *   代价：ASCII 开头的混合列表（`ROI/时间窗/抽样/`）仍会误报，但降级层已保证
 *   它不再变灰字，最多一次链接闪现。
 * - 尾斜杠后是开启式标点或其他字符：不认（`GDPR/《个保法》`、`TB/摄像头`）。
 */
function isTrailingSlashDirCandidate(candidate: string, following: string | undefined): boolean {
	if (!hasPlausibleSegment(candidate)) return false;
	if (DIR_STRONG_PREFIX_RE.test(candidate)) return true;
	const segments = candidate
		.replace(/[\\/]+$/, "")
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0);
	if (!segments.some((segment) => /[A-Za-z0-9]/.test(segment))) return false;
	if (following === undefined || DIR_TRAILING_BOUNDARY_RE.test(following)) return true;
	if (CJK_LETTER_RE.test(following)) {
		return segments.length >= 2 && ASCII_PATH_SEGMENT_RE.test(segments[0]);
	}
	return false;
}

/**
 * 提取文本中的裸文件路径候选。
 * 完整 URL 先整体替换成等长空格再匹配：URL 尾巴（example.com/docs/a.md）长得
 * 就像嵌套路径，逐字符守卫（"://" 前缀、"//" 开头）总能被切分位置绕过；
 * 打码后索引不变，命中的 path 从原文按区间截取，调用方拿到的仍是原文本。
 *
 * 四条规则并行扫描后合并：带扩展名的文件（FILE_PATH_RE）、尾斜杠目录、无扩展名目录、
 * 无扩展名白名单文件。目录候选常常是文件路径的前缀（`src/main/` ⊂ `src/main/index.ts`），
 * 因此合并时按「起点更早、长度更长」优先，保证一个 token 只产出一个候选。
 */
export function matchPlainFilePaths(text: string): PlainFilePathMatch[] {
	const masked = text.replace(URL_RE, (matched) => " ".repeat(matched.length));
	const candidates: PlainFilePathMatch[] = [];
	const collect = (regex: RegExp, accept?: (value: string, following: string | undefined) => boolean) => {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(masked)) !== null) {
			// following = 命中区间之后紧邻的一个字符（文本末尾为 undefined），
			// 供尾斜杠候选判断「这个斜杠是不是真的在收尾」。
			if (accept && !accept(match[0], masked[match.index + match[0].length])) continue;
			candidates.push({ path: text.slice(match.index, match.index + match[0].length), start: match.index, end: match.index + match[0].length });
		}
	};
	collect(FILE_PATH_RE);
	collect(TRAILING_SLASH_DIR_RE, isTrailingSlashDirCandidate);
	collect(BARE_DIR_RE);
	collect(NAMELESS_FILE_RE);
	candidates.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: PlainFilePathMatch[] = [];
	for (const candidate of candidates) {
		const previous = merged.at(-1);
		if (previous && candidate.start < previous.end) {
			if (candidate.end > previous.end) merged[merged.length - 1] = candidate;
			continue;
		}
		merged.push(candidate);
	}
	return merged;
}

/** ~ 及 ~/ 开头视为绝对引用：~ 固定指用户家目录，不随项目 base 变化。 */
function isTildePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * 规范化 Markdown 显式本地链接的目标（仅返回路径）。
 *
 * AI 常把 Windows 绝对路径写成 Markdown URL 形式 `/C:/...:42`；前导 `/`
 * 是 URL 表示法的一部分，不是 Windows 路径的一部分，末尾 `:42`/`:42:7`
 * 是位置标记，也不能参与 stat 或文件打开。校验与点击必须共用此结果，
 * 否则链接会先以未知状态显示，随后因 stat 错误降级成不可点击文本。
 */
export function normalizeFileLinkPath(path: string): string {
	return extractFileLinkLocation(path).path;
}

/** 解析结果：路径 + 可选行号/列号（1 起，位置标记来自 `path:line[:col]`）。 */
export interface FileLinkLocation {
	path: string;
	line?: number;
	column?: number;
}

/**
 * 解析 Markdown 显式本地链接的目标：分开「真实文件路径」与「行[:列] 位置标记」。
 * 调用方既能用 path 做存在性校验/打开文件，也能用 line 打开后滚动定位
 * （对齐 Claude Code / VS Code 的 file.ts:42 语义）。normalizeFileLinkPath
 * 委托本函数，保证「校验的路径」=「点击打开的路径」= 本函数返回的 path。
 */
export function extractFileLinkLocation(path: string): FileLinkLocation {
	let normalized = path;
	try {
		normalized = decodeURIComponent(path);
	} catch {
		// 非完整 URI 编码时保留原文；主流程仍会按原路径做安全校验。
	}
	if (/^\/[A-Za-z]:[\\/]/.test(normalized)) normalized = normalized.slice(1);
	const locationMatch = /:(\d+)(?::(\d+))?$/.exec(normalized);
	if (!locationMatch) return { path: normalized };
	const line = Number(locationMatch[1]);
	const column = locationMatch[2] === undefined ? undefined : Number(locationMatch[2]);
	const result: FileLinkLocation = { path: normalized.slice(0, locationMatch.index) };
	if (Number.isFinite(line)) result.line = line;
	if (column !== undefined && Number.isFinite(column)) result.column = column;
	return result;
}

export function isAbsoluteFilePath(path: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path) || path.startsWith("/") || isTildePath(path);
}

function usesWindowsPathSyntax(path: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/**
 * 浏览器侧不能依赖 node:path；这里按路径自身语法做词法规范化。
 * `.`/`..` 会在发 IPC 前折叠，但最终授权仍由主进程基于真实项目根和 realpath 判定。
 */
function normalizeLexicalFilePath(path: string, windowsStyle = usesWindowsPathSyntax(path)): string {
	if (!path) return path;
	const separator = windowsStyle ? "\\" : "/";
	let prefix = "";
	let rest = path;
	let protectedSegments = 0;

	const drive = /^([A-Za-z]:)[\\/]/.exec(path);
	if (drive) {
		prefix = `${drive[1]}${separator}`;
		rest = path.slice(drive[0].length);
	} else if (windowsStyle && /^[\\/]{2}/.test(path)) {
		// UNC 的 server/share 是根的一部分，`..` 不能越过 share。
		prefix = separator.repeat(2);
		rest = path.replace(/^[\\/]+/, "");
		protectedSegments = 2;
	} else if (path.startsWith("/")) {
		prefix = separator;
		rest = path.replace(/^[\\/]+/, "");
	} else if (isTildePath(path)) {
		prefix = "~";
		rest = path.slice(1).replace(/^[\\/]+/, "");
	}

	const segments: string[] = [];
	for (const segment of rest.split(/[\\/]+/)) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > protectedSegments && segments.at(-1) !== "..") {
				segments.pop();
			} else if (!prefix) {
				segments.push(segment);
			}
			continue;
		}
		segments.push(segment);
	}

	const joined = segments.join(separator);
	if (!prefix) return joined;
	if (!joined) return prefix;
	return prefix.endsWith(separator) ? `${prefix}${joined}` : `${prefix}${separator}${joined}`;
}

type ParsedWslUncPath = {
	distro: string;
	linuxPath: string;
};

/** 解析 WSL 的 `\\wsl$` / `\\wsl.localhost`（含正斜杠形式），保留 Linux 路径大小写。 */
function parseWslUncPath(path: string): ParsedWslUncPath | null {
	const match = path.match(/^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i);
	if (!match) return null;
	const suffix = match[2]?.replace(/[\\/]+/g, "/") ?? "";
	return {
		distro: match[1],
		linuxPath: normalizeLexicalFilePath(`/${suffix}`, false),
	};
}

/** 把 runtime 的 Linux cwd 对齐到 ProjectStore 使用的 WSL UNC 表示。 */
function alignPathToProjectRoot(path: string, projectRoot: string): string | null {
	const rootWsl = parseWslUncPath(projectRoot);
	if (!rootWsl) return path;
	const pathWsl = parseWslUncPath(path);
	let linuxPath: string;
	if (pathWsl) {
		// 不同发行版是不同文件系统，即使 Linux 路径文本相同也不能互相授权。
		if (pathWsl.distro.toLowerCase() !== rootWsl.distro.toLowerCase()) return null;
		linuxPath = pathWsl.linuxPath;
	} else if (path.startsWith("/")) {
		linuxPath = normalizeLexicalFilePath(path, false);
	} else {
		return path;
	}
	const suffix = linuxPath === "/" ? "" : linuxPath.slice(1).replace(/\//g, "\\");
	return `\\\\wsl.localhost\\${rootWsl.distro}${suffix ? `\\${suffix}` : ""}`;
}

/** 判断 target 是否位于 root 内（含 root 本身），并遵循各文件系统的大小写语义。 */
export function isFilePathInsideRoot(target: string, root: string): boolean {
	if (!target || !root) return false;
	const alignedTarget = alignPathToProjectRoot(target, root);
	const alignedRoot = alignPathToProjectRoot(root, root);
	if (!alignedTarget || !alignedRoot) return false;
	const rootWsl = parseWslUncPath(alignedRoot);
	const targetWsl = parseWslUncPath(alignedTarget);
	if (rootWsl || targetWsl) {
		if (!rootWsl || !targetWsl) return false;
		if (rootWsl.distro.toLowerCase() !== targetWsl.distro.toLowerCase()) return false;
		// WSL 的 host/distro 是 Windows 名称；其后的 Linux 路径必须保留大小写。
		return targetWsl.linuxPath === rootWsl.linuxPath || targetWsl.linuxPath.startsWith(`${rootWsl.linuxPath.replace(/\/$/, "")}/`);
	}

	const rootIsWindows = usesWindowsPathSyntax(alignedRoot);
	if (usesWindowsPathSyntax(alignedTarget) !== rootIsWindows) return false;
	const normalizeForCompare = (value: string) => {
		let normalized = normalizeLexicalFilePath(value, rootIsWindows).replace(/\\/g, "/");
		if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
			normalized = normalized.replace(/\/+$/, "");
		}
		return rootIsWindows ? normalized.toLowerCase() : normalized;
	};
	const normalizedTarget = normalizeForCompare(alignedTarget);
	const normalizedRoot = normalizeForCompare(alignedRoot);
	if (normalizedTarget === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
	return normalizedTarget.startsWith(prefix);
}

/**
 * 把 root 内的绝对路径转成相对路径显示（「复制相对路径」右键项用）。
 * 渲染层无 node:path：词法剥离 root 前缀，Windows 大小写不敏感按小写比较；
 * target 不在 root 内（含 WSL 跨发行版）返回 null，调用方应禁用该项。
 */
export function relativeFilePathWithinRoot(target: string, root: string): string | null {
	if (!target || !root || !isFilePathInsideRoot(target, root)) return null;
	const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\//g, "\\");
	const normalizedTarget = normalize(target);
	const normalizedRoot = normalize(root);
	if (normalizedTarget === normalizedRoot) return "";
	const rootWithSep = `${normalizedRoot}\\`;
	const lowerTarget = normalizedTarget.toLowerCase();
	const lowerRoot = rootWithSep.toLowerCase();
	return lowerTarget.startsWith(lowerRoot) ? normalizedTarget.slice(rootWithSep.length) : null;
}

/**
 * 相对路径按 basePath 解析，并可选收敛到 projectRoot。
 *
 * - `.`/`..` 在渲染层先做词法规范化，避免同一文件产生多个缓存键；
 * - 指定 projectRoot 时，绝对路径和相对路径都必须落在项目内，否则返回 null；
 * - 主进程仍会按 ProjectStore 根目录 + realpath 再校验，渲染层判断只负责尽早拒绝和改善提示；
 * - `~` 保持用户家目录语义；在有 projectRoot 的会话入口中通常会因越界而被拒绝。
 */
export function resolveFileLinkPath(path: string, basePath?: string, projectRoot?: string): string | null {
	const normalized = normalizeFileLinkPath(path);
	if (!normalized) return null;

	let resolved: string;
	if (isAbsoluteFilePath(normalized)) {
		resolved = normalizeLexicalFilePath(normalized);
	} else {
		if (!basePath) return null;
		const windowsStyle = usesWindowsPathSyntax(basePath);
		const separator = windowsStyle ? "\\" : "/";
		resolved = normalizeLexicalFilePath(`${basePath.replace(/[\\/]+$/, "")}${separator}${normalized.replace(/^[\\/]+/, "")}`, windowsStyle);
	}

	if (projectRoot) {
		const aligned = alignPathToProjectRoot(resolved, projectRoot);
		if (!aligned || !isFilePathInsideRoot(aligned, projectRoot)) return null;
		return aligned;
	}
	return resolved;
}
