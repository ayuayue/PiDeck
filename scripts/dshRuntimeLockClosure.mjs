/**
 * 从 package-lock.json（lockfileVersion 3）遍历 DSH runtime 依赖闭包。
 *
 * 为什么存在：pack-dsh-runtime.mjs 原本从「项目 node_modules」收集闭包，这要求
 * 每个目标平台都有一台原生 runner（node-pty/sharp/koffi 的 prebuild 在 npm ci 时
 * 按本机平台落位）。2026-09 实证：registry 的平台二进制全部以 prebuild 形式分发
 * （node-pty 自带全平台 prebuilds、koffi=@koromix/koffi-*、sharp=@img/sharp-*、
 * rg=@vscode/ripgrep-*），`npm install --os --cpu --libc --ignore-scripts` 可以在
 * 任意宿主上交叉解析出目标平台完整树（WSL 真机 boot 通过）。于是打包改为：
 *
 *   lock 闭包遍历（本模块） → 生成「精确版本表」→ 在隔离目录 npm install
 *   （--os/--cpu/--libc/--ignore-scripts）→ 复用现有闭包收集/裁剪/打包。
 *
 * 本模块只做纯数据操作（不落盘、不联网），落位交给 npm，避免重写 arborist。
 *
 * 关键设计——为什么输出「精确版本表」而不是直接用 ^range 安装：
 * dsh 子包之间用 ^0.1.5-rc.1 互引，npm 对 prerelease 的 caret 语义会浮动到更新的
 * rc（实测声明 0.1.5-rc.1 会装出 230 个 rc.2 包）。项目 devDependencies 已把全部
 * dsh 包精确 pin，配合 package-lock 锁定整树。隔离目录里没有项目 lock 可用
 * （它含 electron/playwright 等巨无霸，npm ci 全树要 10 分钟+），所以把闭包内
 * 每个包的 lock 精确版本写进临时 package.json 的 dependencies——npm 解析子依赖
 * 的 ^range 时会复用顶层已钉死的精确版本（满足范围即去重），从根上消除漂移。
 */
import semver from "semver";

/**
 * 判断 lock 条目是否为「活包」。
 * dev:true 的条目是 devDependencies 闭包（dsh 包在项目里就是 devDependencies），
 * 必须放行；optional:true 的平台二进制包同样放行（由调用方按平台过滤）。
 * link:true 的条目是 file: 本地包的 symlink 占位，真实元数据在 resolved 指向的
 * 路径条目里，调用方负责解引用。
 */
export function isActivePackageEntry(entry) {
	return Boolean(entry && entry.version && !entry.link);
}

/**
 * 把 lock 的 key（"node_modules/@deepseek-ai/dsh" 或
 * "node_modules/@deepseek-ai/dsh-x/node_modules/y"）拆成段。
 * 返回 null 表示该 key 不是 node_modules 下的包条目（如根 ""、packages/…）。
 */
export function parseLockKey(key) {
	if (!key.startsWith("node_modules/")) return null;
	return key.split("/");
}

/**
 * 在 lock 的 key 空间里做「从 fromKey 出发向上解析包名」。
 *
 * ⚠不能沿用 Node 模块解析的「先向上命中即返回」语义：lock 记录的是 npm 的真实
 * 落位——同名多版本时，非顶层版本的包会嵌套在依赖它的包下面。典型场景：
 * 顶层 node-pty@1.1.0（项目 production 依赖占用）+ dsh-subprocess-local 要求
 * node-pty@1.2.0-beta.15 → lock 里出现嵌套副本。按顶层解析会丢嵌套副本，
 * 归档里 dsh-subprocess-local 加载的 node-pty 版本就错了。
 *
 * 正确语义：沿 key 层级从浅到深列出全部同名候选，取**声明范围满足**的第一个；
 * 都不满足时退化到最浅候选并交由多版本表暴露（与 npm 行为一致：范围总有一个满足，
 * 否则 npm install 当初就报错不会生成这份 lock）。
 */
export function resolveLockPackageKey(fromKey, name, lockPackages, range) {
	const segments = parseLockKey(fromKey);
	if (!segments) return null;
	const candidates = [];
	// 候选位置枚举（最浅优先）：在父包 key 的每个「node_modules 段后」与「包名后」
	// 拼接 node_modules/name。例：父包 key = node_modules/A/node_modules/B，找 koffi：
	//   node_modules/koffi（顶层，Node 解析先命中）
	//   node_modules/A/node_modules/koffi（A 的嵌套）
	//   node_modules/A/node_modules/B/node_modules/koffi（B 的嵌套）
	// 注意 B 的嵌套是「B 完整 key + /node_modules/name」，即父包 key 结尾（包名后）
	// 也是一个插入点——只在 node_modules 段后拼会漏掉它。
	const prefixes = [];
	// 第一个候选：顶层（前缀为空串）—— Node 解析最先命中，也是最常命中的。
	prefixes.push("");
	// 后续候选：父包 key 内每个 node_modules 段之后（嵌套一层）。
	for (let i = 0; i < segments.length; i += 1) {
		if (segments[i] === "node_modules") prefixes.push(segments.slice(0, i + 1).join("/"));
	}
	// 最后一个插入点：父包 key 自身结尾（包名后接嵌套 node_modules）。
	prefixes.push(segments.join("/"));
	for (const prefix of prefixes) {
		// prefix 为空串时 candidate 以 / 开头，去掉前导斜杠得到顶层 node_modules/name。
		const candidate = `${prefix ? `${prefix}/` : ""}node_modules/${name}`;
		if (lockPackages[candidate] && !candidates.includes(candidate)) candidates.push(candidate);
	}
	if (candidates.length === 0) return null;
	if (candidates.length === 1 || !range) return candidates[0];
	// 范围匹配用 semver（build 脚本场景，devDependencies 里有；手工实现 semver
	// 已经出过 ^3.1.0 不满足 3.2.1 的错判，不再手写）。
	const satisfier = candidates.find((key) => semver.satisfies(lockPackages[key]?.version ?? "", range, { includePrerelease: true }));
	return satisfier ?? candidates[0];
}

/**
 * 解引用 file: 本地包（link 条目）。lock v3 里 node_modules/dsh-tool-pwsh-persistent
 * 是 link:true + resolved:"packages/dsh-tool-pwsh-persistent"，真实 deps 在
 * packages["packages/dsh-tool-pwsh-persistent"] 条目（key 不带 node_modules 前缀）。
 */
export function resolveLinkEntry(lockPackages, key, entry) {
	if (!entry?.link) return { key, entry };
	const target = entry.resolved;
	if (typeof target !== "string") return { key, entry: null };
	const realEntry = lockPackages[target];
	return realEntry ? { key: target, entry: realEntry } : { key, entry: null };
}

/**
 * 遍历闭包（BFS，语义与 pack-dsh-runtime 的 collectClosure 一致）：
 * 只跟随 dependencies + optionalDependencies，不跟 peerDependencies（cordis 生态
 * 大量 peer 指向宿主提供的包，跟进去会把 react-dom 之类拖进来）与 devDependencies。
 *
 * @param {Record<string, any>} lockPackages package-lock.json 的 packages 字段
 * @param {string[]} seedNames 种子包名（@deepseek-ai 作用域全集 + dsh-bill + dsh-tool-pwsh-persistent）
 * @returns {{ keys: string[], versions: Map<string, string>, multiVersion: Map<string, string[]> }}
 *   keys      闭包内全部 lock key（含嵌套与 file: 解引用后的真实条目 key）
 *   versions  包名 → lock 顶层条目的精确版本（多版本包名取顶层版本，供临时 package.json 使用）
 *   multiVersion 同名多版本的完整清单（诊断用；npm 会按语义把次要版本嵌套落位）
 */
export function collectLockClosure(lockPackages, seedNames) {
	const keys = [];
	const seen = new Set();
	const versionByName = new Map();
	const multiVersion = new Map();
	const queue = [];

	// 种子先解析成 lock key：优先顶层 node_modules/<name>；file: 链接解引用到真实条目。
	for (const name of seedNames) {
		const topKey = `node_modules/${name}`;
		const entry = lockPackages[topKey];
		if (!entry) continue; // 种子缺失由调用方报错（lock 与 package.json 不同步）
		const { key: realKey, entry: realEntry } = resolveLinkEntry(lockPackages, topKey, entry);
		if (!realEntry) continue;
		if (!seen.has(topKey)) {
			seen.add(topKey);
			keys.push(topKey);
			recordVersion(versionByName, multiVersion, name, entry.version);
		}
		if (realKey !== topKey && !seen.has(realKey)) {
			seen.add(realKey);
			keys.push(realKey);
		}
		// ⚠队列里的 key 必须是 node_modules 视角（topKey），不能是解引用后的真实条目
		// key（packages/…，非 node_modules 前缀）：后续依赖解析靠 parseLockKey 从
		// 这个 key 向上构造候选，file: 包的依赖（node-pty 等）必须解析到 workspace 顶层。
		queue.push({ key: topKey, entry: realEntry });
	}

	while (queue.length > 0) {
		const { key, entry } = queue.pop();
		const deps = { ...entry.dependencies, ...entry.optionalDependencies };
		for (const [name, range] of Object.entries(deps)) {
			// 按声明范围解析：同名多版本时 lock 里同时存在顶层与嵌套条目，
			// 必须选范围满足的那个（Node 向上先命中语义在 lock 空间不成立，见函数注释）。
			const depKey = resolveLockPackageKey(key, name, lockPackages, range);
			// 找不到条目有两种可能：peer 由宿主提供（跳过），或 lock 与 package.json 不同步
			// （由调用方在安装阶段失败暴露，这里静默跳过保持遍历健壮）。
			if (!depKey) continue;
			const depEntry = lockPackages[depKey];
			if (!isActivePackageEntry(depEntry)) continue;
			const { key: realKey, entry: realEntry } = resolveLinkEntry(lockPackages, depKey, depEntry);
			if (!realEntry) continue;
			if (!seen.has(depKey)) {
				seen.add(depKey);
				keys.push(depKey);
				recordVersion(versionByName, multiVersion, name, depEntry.version);
			}
			if (realKey !== depKey && !seen.has(realKey)) {
				seen.add(realKey);
				keys.push(realKey);
			}
			if (realEntry.dependencies || realEntry.optionalDependencies) {
				queue.push({ key: realKey, entry: realEntry });
			}
		}
	}

	return { keys, versions: versionByName, multiVersion };
}

function recordVersion(versionByName, multiVersion, name, version) {
	const existing = versionByName.get(name);
	if (existing === version) return;
	if (existing === undefined) {
		versionByName.set(name, version);
		return;
	}
	// 同名多版本：顶层版本优先保留（npm 落位时次要版本会嵌套），完整清单进诊断。
	const list = multiVersion.get(name) ?? [existing];
	if (!list.includes(version)) list.push(version);
	multiVersion.set(name, list);
}

/**
 * 生成「临时 package.json 的 dependencies」：包名 → lock 顶层精确版本。
 * 直接返回 versions 表（调用方再叠加 file: 本地包的 file: 引用）。
 */
export function pinnedDependenciesFromClosure(versions) {
	const deps = {};
	for (const [name, version] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		deps[name] = version;
	}
	return deps;
}

/**
 * 判断 lock 条目是否为「平台专有包」——即必须保持 optional 语义的包。
 *
 * 背景（2026-09-18 实证）：把闭包内所有包一视同仁写进 dependencies 会让 npm
 * 在非目标平台上报 notsup 硬错误退出（如 @deepseek-ai/node-addon-system-darwin-arm64
 * wanted darwin/arm64, current win32/x64）。这些包在 lock/registry 里都是
 * optionalDependencies（@koromix/koffi-*、@img/sharp-*、@vscode/ripgrep-*、
 * node-addon-system-* 等），npm 靠 optional + os/cpu 过滤才装得上。
 *
 * 判据：lock 条目带 os/cpu/libc 任一字段（平台门控），或 lock 标记 optional:true。
 * 这些包写进临时 package.json 的 optionalDependencies；其余写 dependencies。
 */
export function isPlatformGatedEntry(entry) {
	if (!entry) return false;
	if (entry.optional === true) return true;
	return Array.isArray(entry.os) || Array.isArray(entry.cpu) || Array.isArray(entry.libc);
}

/**
 * 目标平台三元组的合法性（--target-os/--target-arch/--target-libc）。
 * libc 只对 linux 有意义（darwin/win32 的平台包不声明 libc）；显式传 musl 用于
 * Alpine/musl 发行版变体，glibc 是 PiDeck AppImage/deb/tar.gz 的目标。
 */
export const TARGET_OSES = ["win32", "darwin", "linux"];
export const TARGET_ARCHES = ["x64", "arm64"];
export const TARGET_LIBCS = ["glibc", "musl"];

export function normalizeTarget({ os, arch, libc }) {
	if (!TARGET_OSES.includes(os)) return { error: `unsupported --target-os: ${os}` };
	if (!TARGET_ARCHES.includes(arch)) return { error: `unsupported --target-arch: ${arch}` };
	let normalizedLibc;
	if (libc) {
		if (!TARGET_LIBCS.includes(libc)) return { error: `unsupported --target-libc: ${libc}` };
		if (os !== "linux") return { error: `--target-libc only applies to linux (got os=${os})` };
		normalizedLibc = libc;
	} else if (os === "linux") {
		// 缺省 glibc：npm 在非 Linux 宿主上检测不到 libc，会把 libc:["glibc"] 的平台包
		// （@img/sharp-linux-x64 等）静默过滤掉——这是交叉打包唯一的「静默缺包」坑，
		// 所以这里必须显式补上，不能依赖 npm 的平台探测。
		normalizedLibc = "glibc";
	}
	return { os, arch, libc: normalizedLibc };
}

/**
 * 组装 npm install 的平台参数（--os/--cpu/--libc）。
 * 返回 [flag, value, ...] 平铺数组，供 execFile 直接使用。
 */
export function npmPlatformArgs(target) {
	const args = ["--os", target.os, "--cpu", target.arch, "--ignore-scripts", "--omit=dev"];
	if (target.libc) args.push("--libc", target.libc);
	return args;
}
