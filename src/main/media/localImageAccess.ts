import { isAbsolute, relative } from "node:path";
import { isLocalImageExtension, LOCAL_IMAGE_MAX_BYTES } from "../../shared/localImage";

/**
 * 本地图片请求的访问判定（纯函数为主：不碰 electron，可被 node:test 直接导入）。
 *
 * 背景：`pideck-file://` 把「渲染层能不能读某个本地文件」这件事实体化了，因此必须有一份
 * 可单测的判定，而不是散在 protocol handler 的 if 里。三道闸：
 * 1. 形态：绝对路径、非 UNC、无控制字符、扩展名属于图片；
 * 2. 边界：真实路径必须落在白名单根目录内；
 * 3. 体积：超过 `LOCAL_IMAGE_MAX_BYTES` 一律拒绝（防超大文件整读进内存）。
 *
 * 白名单的取舍（见 docs/markdown-image-rendering-plan.md）：项目目录 + userData +
 * 专属临时图片目录。**不放行整个 %TEMP%**——安装器/解压/其它程序的公共池，当图床用
 * 等于白名单失效。
 */

/** 拒绝原因到 HTTP 状态码：与生图协议、文件接口的语义保持一致。 */
export type LocalImageRejection = 400 | 403 | 404 | 413;

export type LocalImageAccessDecision = { ok: true; path: string } | { ok: false; status: LocalImageRejection };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** UNC（`\\server\share`）：宿主侧协议服务不到远程共享，也不在根白名单语义内。 */
const UNC_PATH = /^[\\/]{2}/;

/**
 * 目标是否落在根目录内（含根本身）。
 *
 * 与 `isPathInsideProject` 同为「词法边界」判定，但这里刻意不复用 main/fs 的实现：
 * 那条 import 链会带进 logging/electron，纯判定模块一旦依赖它就失去可单测性。
 */
export function isInsideRoot(root: string, target: string): boolean {
	if (root === "" || target === "") return false;
	const rel = relative(root, target);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	return !isAbsolute(rel);
}

/**
 * 白名单根目录的规范化（2026-10 实测事故的直接修复）。
 *
 * 事故：`app.getPath("temp")` 在 Windows 上返回 **8.3 短名**
 * （`C:\Users\ADMINI~1\AppData\Local\Temp`），而消息里引用的路径是长名
 * （`C:\Users\Administrator\…`）。`path.relative` 把两者当成完全不同的目录 →
 * 白名单内的临时图片全被判 403，只有项目目录里的图能显示。
 *
 * 所以比较前两侧都要过 **native realpath**（`nativeRealpath.ts`）：普通
 * `fs/promises.realpath` 在 Windows 上不展开中间段的短名，防不住这个坑。
 * 请求路径在 handler 里 realpath，根目录在这里 realpath。realpath 失败
 * （目录还不存在、权限不足）时退回原值——那种情况下目录里也不可能有能读到的
 * 文件，不会放宽真实边界。
 *
 * @param roots 原始白名单根（可能是短名/符号链接/大小写不同）。
 * @param resolvePath 真实路径解析器（生产传 native realpath，测试可注入）。
 * @returns 与 `realpath(请求路径)` 同口径的根目录列表。
 */
export async function canonicalizeRoots(roots: readonly string[], resolvePath: (path: string) => Promise<string>): Promise<string[]> {
	const seen = new Set<string>();
	const canonical: string[] = [];
	for (const root of roots) {
		if (!root) continue;
		const resolved = await resolvePath(root).catch(() => root);
		const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
		if (seen.has(key)) continue;
		seen.add(key);
		canonical.push(resolved);
	}
	return canonical;
}

/** 真实路径是否落在任一白名单根内。 */
export function isInsideAnyRoot(target: string, roots: readonly string[]): boolean {
	return roots.some((root) => isInsideRoot(root, target));
}

/**
 * 请求路径的形态闸（不含边界：边界必须用 realpath 之后的真实路径判定）。
 * @param rawPath 协议 URL 里的 `path` 参数（已解码）。
 */
export function classifyLocalImagePath(rawPath: string | null): LocalImageAccessDecision {
	if (rawPath === null || rawPath === "") return { ok: false, status: 400 };
	if (CONTROL_CHARS.test(rawPath)) return { ok: false, status: 400 };
	if (!isAbsolute(rawPath)) return { ok: false, status: 400 };
	if (UNC_PATH.test(rawPath)) return { ok: false, status: 403 };
	if (!isLocalImageExtension(rawPath)) return { ok: false, status: 403 };
	return { ok: true, path: rawPath };
}

/** 体积闸：`undefined`（stat 拿不到大小）按超限处理，宁可不显示也不整读大文件。 */
export function isLocalImageSizeAllowed(sizeBytes: number | undefined): boolean {
	return typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= LOCAL_IMAGE_MAX_BYTES;
}
