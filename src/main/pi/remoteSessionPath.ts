/**
 * pi 上报的**远端**会话文件路径归一化。
 *
 * 为什么需要它：pi 的 `sessionDir` 是相对路径时（例如项目级 `.pi/settings.json` 写
 * `"sessionDir": ".pi/sessions"`），`normalizePath` 不会把它绝对化，于是 `get_state.sessionFile`
 * 回来的是相对 cwd 的 `.pi/sessions/<file>.jsonl`。远端链路的身份、重启参数与 catalog 写入都要求
 * 绝对 POSIX 形状：原样写进 `tab.sessionPath` 会让 `--session` 重启依赖 pi 的 cwd、让换绑比较
 * 绝对/相对失配（fork 直接失败），登记侧也会因为「不是绝对路径」拒绝。
 *
 * 判据只看形状，不看文件系统（远端路径在本机不可 stat）：
 * - 绝对或相对都先规范化（折叠 `.`/空段、消解 `..`），结果必须是 `/` 开头的 POSIX 绝对路径；
 * - 反斜杠与控制字节一律拒绝：它们不可能出现在 pi 在 POSIX 主机上写出的会话路径里，放进来只会
 *   让后续的命令行拼接与身份比较产生两种写法；
 * - 相对路径按 pi 自己的 cwd 解析——远端 pi 由 PiDeck 以**项目根**为 cwd 拉起，两者同源。
 *
 * 本地（含 WSL）不走这里：那条链路有平台感知的 `toAbsoluteSessionPath`，把 `/home/...` 丢给本机
 * 规则会拼成盘符路径（见 `AgentManager.reportSessionPathFromPi` 的注释）。
 */

/** 远端路径里出现即拒绝的字符：控制字节与分隔符方向错误（POSIX 上 `\` 是普通字符，但不是 pi 的写法）。 */
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

/**
 * 规范化 POSIX 绝对路径；相对输入按 `base` 解析。`base` 必须是绝对路径。
 * 越过根（`..` 逃出发根）或结果为空返回 undefined——不猜、不截断。
 */
function normalizePosixAbsolute(value: string, base?: string): string | undefined {
	if (typeof value !== "string" || value.length === 0 || FORBIDDEN.test(value)) return undefined;
	const rooted = value.startsWith("/") ? value : base === undefined ? undefined : base.replace(/\/+$/, "") + "/" + value;
	if (rooted === undefined) return undefined;
	const segments: string[] = [];
	for (const segment of rooted.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length === 0 ? undefined : "/" + segments.join("/");
}

/** 这条路径是否已经是规范的 POSIX 绝对路径（远端会话文件、`--session` 参数只接受它）。 */
export function isAbsoluteRemoteSessionPath(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const normalized = normalizePosixAbsolute(value);
	return normalized !== undefined && normalized === value;
}

/**
 * pi 上报的会话文件 → 绝对 POSIX 路径。
 *
 * 解析不出来返回 undefined（调用方保留上一份已知路径或走失败分支），绝不返回一个「看起来能用」的
 * 拼接结果。`remoteCwd` 不是绝对路径时无法解析相对输入——那属于装配错误，同样返回 undefined。
 */
export function resolveRemoteReportedSessionPath(reported: string, remoteCwd: string): string | undefined {
	if (typeof reported === "string" && reported.startsWith("/")) return normalizePosixAbsolute(reported);
	if (typeof remoteCwd !== "string" || !remoteCwd.startsWith("/") || FORBIDDEN.test(remoteCwd)) return undefined;
	return normalizePosixAbsolute(reported, remoteCwd);
}
