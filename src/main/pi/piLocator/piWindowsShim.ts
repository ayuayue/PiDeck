import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Windows 启动通道域（PiLocator 拆分第一刀）：`.cmd` 垫片还原 + `cmd.exe /c` 回退形态。
 *
 * 这里只出「命令形状」，不碰候选枚举与环境变量；宿主 `createInvocation` 拿结果决定
 * `node-direct` 还是 `cmd-shim`。所有注释都是现场结论（跨 arch、引号语义、npm 12+ 变量式垫片），
 * 搬动时不要删。
 */

/** .cmd 垫片解析结果：命中 node 直启入口，或说明为何不能直启。 */
export type CmdShimResolution = { kind: "entry"; entry: string; matchedBy: "prefix-relative" | "shim-relative" } | { kind: "not-cmd" } | { kind: "missing" } | { kind: "unreadable" } | { kind: "unrecognized" } | { kind: "entry-missing"; candidate: string };

/** 把「没能走 node 直启」的解析结果翻成人话（命中时返回 null）。 */
export function describeCmdShimFallback(resolution: CmdShimResolution, shimPath: string): string | null {
	switch (resolution.kind) {
		case "entry":
			return null;
		case "missing":
			return `pi 路径不存在：${shimPath}（版本管理器切换/卸载后路径失效？）`;
		case "unreadable":
			return `垫片文件读取失败（权限或占用）：${shimPath}`;
		case "unrecognized":
			return "垫片入口无法静态解析（npm 12+ 等变量式 shim：入口由 SET 变量间接引用），已回退 cmd.exe；功能不受影响";
		case "entry-missing":
			return `垫片引用的 JS 入口不存在：${resolution.candidate}（常见于 nvm/pnpm 切换版本后残留的旧垫片）`;
		case "not-cmd":
			return null;
	}
}

/**
 * 入口能否当 node 脚本运行：有 .js/.mjs/.cjs 扩展名，或（无扩展名的 bin 脚本）首行 shebang 指向 node。
 * 只读文件头，避免为了判断把大文件整个读进内存。
 */
function isRunnableNodeEntry(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
	} catch {
		return false;
	}
	if (/\.(?:m?js|cjs)$/i.test(path)) return true;
	// 本地安装的 bin 脚本（node_modules/<pkg>/bin/<name>）通常无扩展名，靠 shebang 认身份。
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(256);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return /^#![^\n]*\bnode\b/m.test(buffer.subarray(0, read).toString("utf8"));
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// 关不掉不影响判断结果
			}
		}
	}
}

/**
 * 解析 Windows npm/pnpm 生成的 .cmd 垫片，取出真实 JS 入口路径（配合 node 直启）。
 *
 * npm 垫片最后一行形如：
 *   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\<pkg>\...\cli.js" %*
 * pnpm 及部分工具的垫片用 `%~dp0`。两种前缀都识别，但只接受落在
 * `<垫片目录>\node_modules\` 内、且真实存在的 .js/.mjs/.cjs 入口：
 * 垫片来自用户磁盘，属于不可信输入，路径被改写时必须拒绝而非盲从。
 * 形态不符（自建包装脚本、非 node 入口、入口文件缺失）返回 null，由调用方回退 cmd 路径。
 */
export function resolveWindowsCmdShim(shimPath: string): string | null {
	const resolution = resolveWindowsCmdShimDetailed(shimPath);
	return resolution.kind === "entry" ? resolution.entry : null;
}

/**
 * 解析 .cmd 垫片，还原出可 `node <entry>` 直启的 JS 入口。
 *
 * 覆盖两种真实垫片形态（都只在「解析出的入口真实存在」时才接管，否则回退 cmd.exe）：
 *   ① npm 全局安装：`"%dp0%\node_modules\<包>\<入口>.js"`（全局 bin 目录 = node 根目录）；
 *   ② npm 本地安装（`node_modules/.bin/*.cmd`）：`"%dp0%\..\<包>\bin\<脚本>"`，
 *      入口通常**无扩展名**，靠 shebang 认 node 身份。
 * 形态②此前一律落到 cmd.exe 回退 —— 这就是「pi 不是改成 node 启动了吗」的落差点：
 * 改动只覆盖了全局垫片。回退原因现在随 `windowsLaunch.reason` 带出，不再静默。
 *
 * 安全：垫片来自用户磁盘，属不可信输入。「%dp0%」前缀形态必须解析在垫片目录内；
 * 「..」形态必须落在某个 node_modules 包目录内，挡住 `node_modules\..\..\evil.js` 这类改写。
 *
 * 形态不符（自建包装脚本、非 node 入口、入口文件缺失）返回对应 reason，由调用方回退 cmd 路径。
 */
export function resolveWindowsCmdShimDetailed(shimPath: string): CmdShimResolution {
	if (!/\.cmd$/i.test(shimPath)) return { kind: "not-cmd" };
	if (!existsSync(shimPath)) return { kind: "missing" };
	let content: string;
	try {
		content = readFileSync(shimPath, "utf8");
	} catch {
		return { kind: "unreadable" };
	}
	const baseDir = dirname(shimPath);
	// 只在**实际执行行**（含 `%*`）上找入口：新式垫片（npm 12+ 的 npm.cmd/npx.cmd）用
	// `SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"` 变量间接引用，执行行形如
	// `"%NODE_EXE%" "%NPM_CLI_JS%" %*`。若按全文取第一个 `node_modules\…js`，会抓到变量赋值里的
	// `npm-prefix.js`——实测把「装包」跑成「打印前缀」，exit 0 却什么都没装（npm 12.0.2 的 npm.cmd 复现）；
	// 入口变量还可能被 prefix 覆盖，静态解析给不出与 cmd 等价的目标，因此这类形态一律回退 cmd.exe。
	const execLines = content.split(/\r?\n/).filter((line) => line.includes("%*"));

	// ① %dp0% / %~dp0% 之后紧跟 `\<node_modules 相对路径>`；`\\(` 中的反斜杠是字面量，
	// 其后的 `(` 即捕获组起点，整段相对路径由该组取回。
	for (const line of execLines) {
		const match = /%~?dp0%?\\(node_modules[\\/][^"%\r\n]+\.(?:m?js|cjs))/i.exec(line);
		if (!match) continue;
		// 垫片内一律是 Windows 反斜杠；归一成 `/` 使 path.resolve 在 POSIX 宿主上也能正确拼接
		// （测试会以 Linux/macOS 宿主模拟 win32 跑这条分支）。
		const entry = resolve(baseDir, match[1].replace(/\\/g, "/"));
		// 逃逸检查：解析结果必须仍在垫片目录内，挡住 `..\..\` 形态的路径改写。
		const rel = relative(baseDir, entry);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { kind: "entry-missing", candidate: entry };
		return existsSync(entry) ? { kind: "entry", entry, matchedBy: "prefix-relative" } : { kind: "entry-missing", candidate: entry };
	}

	// ② 本地安装垫片：`"%dp0%\..\<包>\bin\<脚本>"`（可继续带 `..`，但必须留在 node_modules 内）
	for (const line of execLines) {
		const shimRelative = /%~?dp0%?\\\.\.\\([^"%\r\n]+)/i.exec(line);
		if (!shimRelative) continue;
		const candidate = resolve(baseDir, `../${shimRelative[1].replace(/\\/g, "/")}`);
		if (/[\\/]node_modules[\\/]/i.test(candidate) && isRunnableNodeEntry(candidate)) {
			return { kind: "entry", entry: candidate, matchedBy: "shim-relative" };
		}
		return { kind: "entry-missing", candidate };
	}

	return { kind: "unrecognized" };
}

/**
 * 跑 .cmd 垫片用的 cmd.exe 路径。
 *
 * 不能只信 ComSpec：它可能指向本机并不存在的位置（系统盘换代、环境变量被改、
 * 从别的机器/环境继承而来），这时 spawn 只会报 "spawn C:\WINDOWS\system32\cmd.exe ENOENT"，
 * 用户根本看不出是 cmd.exe 路径本身失效。逐级退回：ComSpec（存在才用）→
 * %SystemRoot%\System32\cmd.exe → 原样（交给 PATH 解析，至少保留可诊断的报错）。
 */
export function resolveCmdExe(): string {
	const fromEnv = process.env.ComSpec?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const systemRoot = process.env.SystemRoot?.trim() || process.env.windir?.trim();
	if (systemRoot) {
		const candidate = join(systemRoot, "System32", "cmd.exe");
		if (existsSync(candidate)) return candidate;
	}
	return fromEnv || "cmd.exe";
}

export function quoteCmdArgument(value: string) {
	if (!needsCmdQuote(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

export function needsCmdQuote(value: string) {
	// 双引号必须入类：cmd-shim 通道用 windowsVerbatimArguments 把拼好的整条命令行直接交给
	// cmd.exe（没有 Node 的二次转义），裸引号会打乱 /s /c 的引号配对，把后续参数里的 & 甩到
	// 引号外造成命令行分裂（实测 name=a" + 后续参数含 & → cmd 真去执行了 & 后面的命令）。
	// % 故意不入类：引号阻止不了 cmd 的 %VAR% 展开（实测 "a%PATH%b" 照旧被展开），
	// 放进字符类只会让人误以为已处理；含 % 的供应商名改由 isValidProviderName 拒绝。
	// ~ 故意不入类：cmd 不展开 ~（那是 bash 的语义），而 Windows 8.3 短路径
	// （C:\Users\RUNNER~1\...；CI 与部分用户机器的临时/主目录）天生带 ~。把它算进
	// 「需要引号」会让整条命令行多套一层外引号，行尾那个引号直接粘在最后一个参数上
	// （2026-09-30 CI 实证：中文供应商" → 供应商名匹配失败），而无空格时这层引号毫无必要。
	return /[\s&()\[\]{}^=;!'+,`|<>"]/.test(value);
}
