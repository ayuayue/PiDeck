/** Bounded OAuth login runner (shipped as `mcp-login.mjs` next to the helper entry). */
export const REMOTE_MCP_LOGIN_FILE_NAME = "mcp-login.mjs";

/**
 * `pi mcp login <server>` 的受控运行器：只做一件事——把子进程的授权 URL 在**这次调用还没结束时**交给调用方。
 *
 * 为什么必须流式：pi 打印 URL 后会在同一进程里等用户在浏览器完成授权（最长等到 `--timeout`）。只把结果放在
 * 退出时返回，等于让用户永远拿不到那个链接，远端登录就会表现成「点了没反应」。
 *
 * 边界与 helper 其它成员一致：spawn 用数组参数、不经过 shell；server 名与三段路径由调用方先按闭集校验；
 * 只向上报第一个 http(s) URL；输出只留尾部；超时/取消都 kill 子进程，且只 settle 一次。
 */
export const REMOTE_MCP_LOGIN_SOURCE = String.raw`"use strict";
export function createMcpLoginRunner(spawn) {
	const MAX_URL = 2048;
	const MAX_OUTPUT = 4096;
	const TAIL_MS = 30000;
	const URL_PATTERN = /https?:\/\/[^\s"'<>\x60\\]+/;
	const URL_TRAILING = /[),.;:!?\]]+$/;
	function tail(value) { return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value; }
	function findUrl(text) {
		const match = URL_PATTERN.exec(text);
		if (match === null) return null;
		const url = match[0].replace(URL_TRAILING, "");
		if (url.length < 8 || url.length > MAX_URL) return null;
		return url;
	}
	return function start(options, onUrl) {
		let child = null;
		let settled = false;
		let timer = null;
		let output = "";
		let announced = false;
		let resolveOuter = null;
		const done = function (result) {
			if (settled) return;
			settled = true;
			if (timer !== null) { clearTimeout(timer); timer = null; }
			if (child !== null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
			if (resolveOuter !== null) resolveOuter(result);
		};
		const promise = new Promise(function (resolve) { resolveOuter = resolve; });
		const consume = function (chunk) {
			const text = String(chunk);
			if (text.length === 0) return;
			output = tail(output + text);
			if (announced) return;
			const url = findUrl(text);
			if (url === null) return;
			announced = true;
			try { onUrl(url); } catch { /* an observer must never break the child */ }
		};
		const seconds = Math.max(1, Math.min(options.timeoutSec, 600));
		const nodeDir = options.nodePath.slice(0, options.nodePath.lastIndexOf("/"));
		timer = setTimeout(function () { done({ ok: false, output: tail(output), reason: "timeout" }); }, seconds * 1000 + TAIL_MS);
		try {
			child = spawn(options.nodePath, [options.piPath, "mcp", "login", options.server, "--timeout", String(seconds)], {
				cwd: options.home,
				env: Object.assign({}, process.env, { HOME: options.home, PATH: nodeDir + ":" + (process.env.PATH || "/usr/local/bin:/usr/bin:/bin") }),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			done({ ok: false, output: "", reason: "spawn" });
			return { promise: promise, cancel: function () { done({ ok: false, output: "", reason: "cancelled" }); } };
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", consume);
		child.stderr.on("data", consume);
		child.on("error", function () { done({ ok: false, output: tail(output), reason: "spawn" }); });
		child.on("close", function (code) { done({ ok: code === 0, output: tail(output), reason: code === 0 ? "ok" : "exit" }); });
		return { promise: promise, cancel: function () { done({ ok: false, output: tail(output), reason: "cancelled" }); } };
	};
}
`.replace(/\r?\n[\t ]*/g, "");

/** sha256 of REMOTE_MCP_LOGIN_SOURCE as UTF-8 bytes; a bundle whose runner differs never activates. */
export const REMOTE_HELPER_MCP_LOGIN_SHA256 = "38242ab87e6a4b9017c07c6cbf601add4317f5a89296248f0410e98f84f84ccc";
