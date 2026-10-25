/**
 * 把「进程没起来」的底层报错翻译成用户能直接看懂的原因。
 *
 * 背景：Windows 上 `spawn` 的工作目录不存在时，libuv 会把 CreateProcessW 的
 * ERROR_DIRECTORY 映射成 ENOENT，并把错误归到**被 spawn 的程序**头上。于是用户看到的
 * 是「spawn C:\Windows\system32\cmd.exe ENOENT」——既不像「目录没了」，还会把人引去
 * 查 PATH/ComSpec/杀毒软件（实测：cwd 指向不存在的目录即复现该文案，cmd.exe 本身正常）。
 * 桌面端必须把这类错误还原成真实原因，否则诊断卡只能给出误导性的排查步骤。
 */

export type SpawnFailureError = {
	code?: string | null;
	message: string;
};

export type SpawnFailureContext = {
	/** spawn 抛出的原始错误（errno code + message）。 */
	error: SpawnFailureError;
	/** 实际传给 spawn 的程序名（Windows 走 shim 时是 ComSpec/cmd.exe，node 直启时是 node.exe）。 */
	spawnedCommand: string;
	/** 桌面端解析出的 pi 可执行路径，用于对照诊断。 */
	piCommand: string;
	/** 传给 spawn 的工作目录。 */
	cwd: string;
	/** 该工作目录此时是否存在。 */
	cwdExists: boolean;
	cwdIsDirectory: boolean;
	/**
	 * pi 可执行文件/垫片本身是否存在。
	 * Windows 走 cmd.exe 时，pi 路径失效会表现为「cmd.exe 找不到」这类完全误导的报错，
	 * 所以这一位要单独问：`C:\nvm4w\nodejs\pi.cmd` 在 nvm 切版本后是最典型的失效场景。
	 */
	piCommandExists: boolean;
	isWindows: boolean;
};

/**
 * 返回可读原因；无法归因时返回 null（保持原始错误，不做无依据的猜测）。
 * 返回值保证保留原始 errno 文本，便于日志/Issue 仍可按 ENOENT 等关键字检索。
 */
export function describeSpawnFailure(context: SpawnFailureContext): string | null {
	const code = (context.error.code ?? "").toUpperCase();
	const raw = context.error.message.trim();

	if (code === "ENOENT") {
		if (!context.cwdExists || !context.cwdIsDirectory) {
			// 与 spawn 报错逐字对应的实测结论：目录不存在才是这条 ENOENT 的真实原因。
			return [
				`项目工作目录不存在：${context.cwd}`,
				context.isWindows ? "（Windows 会把「工作目录无效」误报成 spawn <cmd.exe> ENOENT，真正原因不是 pi 或 cmd.exe 缺失）" : "（进程启动时无法切换到该目录）",
				`原始错误：${raw}`,
				"处理：确认项目路径是否被移动/重命名/删除，或磁盘（含网络盘）是否已挂载；",
				"在 PiDeck 中重新指定该项目的目录后重启会话。",
			].join("\n");
		}
		if (!context.piCommandExists) {
			// cwd 有效但 pi 路径没了：另一类（且更常见，nvm/fnm 切版本后必现）的失效。
			// 必须排在「找不到可执行文件」之前——Windows 走 cmd.exe 时 spawnedCommand 是 cmd.exe，
			// 说「找不到 cmd.exe」纯属误导。
			return [
				`pi 路径不存在：${context.piCommand}`,
				`原始错误：${raw}`,
				context.isWindows ? "处理：版本管理器（nvm/fnm/nvm4w）切换 Node 版本后，旧版本目录下的 pi.cmd 会失效；" : "处理：重新安装 pi，或在设置中指向当前有效的可执行文件；",
				"在终端执行 `pi --version` 确认；若终端可用，把设置里的 pi 路径改成终端实际命中的那个完整路径。",
			].join("\n");
		}
		return [
			`找不到可执行文件：${context.spawnedCommand}`,
			`pi 路径：${context.piCommand}`,
			`原始错误：${raw}`,
			context.isWindows ? "处理：确认 pi 已全局安装（npm i -g @earendil-works/pi-coding-agent），或在设置中填写 pi 的完整路径；" : "处理：确认 pi 已安装且可执行（which pi / 设置中填写完整路径）；",
			"如果在终端里 `pi --version` 正常，多半是桌面端没有继承到同一套 PATH。",
		].join("\n");
	}

	if (code === "EACCES" || code === "EPERM") {
		return [`没有权限启动：${context.spawnedCommand}`, `原始错误：${raw}`, "处理：检查安全软件/组策略是否拦截了该程序，或该文件是否被占用、只读。"].join("\n");
	}

	return null;
}

/**
 * 把 spawn 失败包装成带原因的错误。无法归因时原样返回，调用方行为不变。
 */
export function createSpawnFailureError(context: SpawnFailureContext): { error: Error; described: boolean } {
	const described = describeSpawnFailure(context);
	if (!described) {
		return {
			error: new Error(context.error.message),
			described: false,
		};
	}
	return { error: new Error(described), described: true };
}
