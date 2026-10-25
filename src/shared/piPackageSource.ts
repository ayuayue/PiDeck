/**
 * pi 包 source 形态的唯一判据（主进程、渲染层与测试共用）。
 *
 * pi 的 packages 条目有两种来源写法：
 * - 协议前缀：`npm:` / `file:` / `git:` / `github:` / `http(s):`
 * - 本地目录：`pi install ./pkg` 或 `pi install F:\\pkg` 时，settings.json 与 `pi list`
 *   里都是裸路径（盘符、UNC、POSIX 绝对或相对），不带任何协议前缀。
 *
 * 解析 `pi list`、判定卸载路由、写整包开关规则都必须用同一套判据，否则会出现
 * 「本地路径包被当成 ~/.pi/agent/extensions 里的文件名」或「整包开关写成顶层路径规则」。
 */

/** Windows 盘符绝对路径：`C:\\dir` 或 `C:/dir`。 */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
/** UNC 路径：`\\\\server\\share`。 */
const UNC_PATH = /^\\\\/;
/** POSIX 绝对路径：`/opt/pkg`。 */
const POSIX_ABSOLUTE = /^\//;
/** 显式相对路径：`./pkg`、`../pkg`。 */
const EXPLICIT_RELATIVE = /^\.\.?[\\/]/;
/** 协议前缀（与 pi list 输出的 source 形态一致）。 */
const PROTOCOL = /^(?:npm|file|github|git|https?):/i;

/** source 是否是本地目录形式的包（而非协议源、也不是 extensions 目录里的裸文件名）。 */
export function isPathLikePackageSource(source: string): boolean {
	const value = source.trim();
	if (!value) return false;
	return WINDOWS_DRIVE.test(value) || UNC_PATH.test(value) || POSIX_ABSOLUTE.test(value) || EXPLICIT_RELATIVE.test(value);
}

/** source 是否是 pi 包（协议源或本地目录包）。 */
export function isPackageSource(source: string): boolean {
	const value = source.trim();
	return PROTOCOL.test(value) || isPathLikePackageSource(value);
}
