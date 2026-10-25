// xterm 主库 + addon 的按需装载器。
// 终端是低频功能（很多人整轮会话都不开终端），但主库 + 6 个 addon + WebGL 渲染器
// 静态 import 会进启动 chunk：每个渲染进程启动都要解析这份 JS 并常驻堆。
// 这里统一收口动态 import，TerminalDock 首次创建终端实例时才装载；模块级缓存
// 保证只装一次，之后走同步的已完成 Promise。
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";

export interface XtermModules {
	Terminal: typeof Terminal;
	FitAddon: typeof FitAddon;
	SearchAddon: typeof SearchAddon;
	SerializeAddon: typeof SerializeAddon;
	Unicode11Addon: typeof Unicode11Addon;
	WebLinksAddon: typeof WebLinksAddon;
	WebglAddon: typeof WebglAddon;
}

let modulesPromise: Promise<XtermModules> | null = null;

/** 装载 xterm 模块组（单飞：并发调用共享同一次 import）。失败置空允许重试。 */
export function loadXtermModules(): Promise<XtermModules> {
	modulesPromise ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search"), import("@xterm/addon-serialize"), import("@xterm/addon-unicode11"), import("@xterm/addon-web-links"), import("@xterm/addon-webgl")]).then(
		([xterm, fit, search, serialize, unicode11, webLinks, webgl]) => ({
			Terminal: xterm.Terminal,
			FitAddon: fit.FitAddon,
			SearchAddon: search.SearchAddon,
			SerializeAddon: serialize.SerializeAddon,
			Unicode11Addon: unicode11.Unicode11Addon,
			WebLinksAddon: webLinks.WebLinksAddon,
			WebglAddon: webgl.WebglAddon,
		}),
	);
	const pending = modulesPromise;
	pending.catch(() => {
		if (modulesPromise === pending) modulesPromise = null;
	});
	return pending;
}
