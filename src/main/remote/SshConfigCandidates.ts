/**
 * `~/.ssh/config` 解析：把用户已经配好的主机列成「可添加」候选。
 *
 * 为什么要扫 config（2026-09，对照 Codex 的做法后确定）：用户要连的主机**几乎总是已经配过 SSH** 的。
 * 再让他把 host/user/port 手打一遍，既啰嗦又容易错；扫出来让他挑一个才是正常体验。手动填写保留为
 * 兜底入口。
 *
 * 设计纪律：
 * - **纯解析，不碰网络也不碰文件系统**：函数只吃字符串，调用方负责读文件。这样「IPv4/端口/别名」
 *   这类安全边界可以完全离线测。
 * - **不做 SSH 语义的完整实现**：只取 `Host` / `HostName` / `User` / `Port` / `IdentityFile`。
 *   `Include`、`Match`、`ProxyCommand` 一律**不展开也不猜**——静默按半套语义解析出的目标，比不解析
 *   更危险。带 `Match`/`Include` 的条目会被跳过并记录原因，交给手动填写。
 * - **通配 Host 不是候选**：`Host *` / `Host *.example.com` 是默认值块，不是一台具体主机；把它当
 *   主机列出来会让用户添加一个「叫 * 的主机」。
 */

/** 单个可添加候选。字段都是用户自己 config 里的值，原样回显以便对照。 */
export type SshConfigCandidate = {
	/** config 里的 Host 别名（唯一，且必须是具体主机而非通配）。 */
	alias: string;
	/** 实际网络目标：HostName 缺省时等于 alias（OpenSSH 语义）。 */
	hostName: string;
	/** 显式 User；缺省为空串，表示「用当前登录用户」。 */
	user: string;
	/** 显式 Port；缺省为 null，表示用 22。 */
	port: number | null;
	/** 显式 IdentityFile；仅为展示「将用哪个身份」，本模块不读该文件。 */
	identityFile: string | null;
};

/** 被跳过的条目及原因：让 UI 能解释「为什么这个主机没出现」，而不是静默少一项。 */
export type SshConfigSkip = { alias: string; reason: "wildcard" | "invalid" | "unsupported-directive" };

export type SshConfigParseResult = { candidates: SshConfigCandidate[]; skipped: SshConfigSkip[] };

/** 别名上限：同一 config 里几千台主机没有意义，反而说明这份文件不该被当成主机清单。 */
const MAX_CANDIDATES = 512;
/** 字段长度上限：防止把整份二进制/超长行当成值带出去。 */
const MAX_FIELD = 1024;
/** 允许出现在 HostName/alias 上的字符：主机名、IPv4、IPv6 字面量、以及 POSIX 可移植文件名集合。 */
const SAFE_HOST = /^[A-Za-z0-9._:[\]-]+$/;
/** user 只允许常见形态；含空白或控制字符的值一律拒绝。 */
const SAFE_USER = /^[A-Za-z0-9._@-]+$/;
/** Host 值里出现这些字符说明它是通配/否定模式，不是一台具体主机。 */
const WILDCARD = /[*?!]/;

function clean(value: string): string {
	const unquoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
	return unquoted.trim();
}

/** 别名必须是一个安全的具体主机名：无通配、无空白/控制字符、长度有界。 */
function aliasIsUsable(alias: string): boolean {
	return alias.length > 0 && alias.length <= MAX_FIELD && !WILDCARD.test(alias) && SAFE_HOST.test(alias);
}

/** 取指令名与值；兼容 `Key=Value`、`Key Value` 与行首缩进。 */
function splitDirective(line: string): { key: string; value: string } | null {
	const trimmed = line.trim();
	if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
	const eq = trimmed.indexOf("=");
	if (eq > 0) {
		const key = trimmed.slice(0, eq).trim();
		// `Key=Value` 形式：SSH 允许等号两侧无空格。
		return { key, value: trimmed.slice(eq + 1).trim() };
	}
	const space = trimmed.search(/\s/);
	if (space <= 0) return { key: trimmed, value: "" };
	return { key: trimmed.slice(0, space), value: trimmed.slice(space + 1).trim() };
}

/**
 * 解析一份 ssh config 文本。
 *
 * 语义按 OpenSSH 的「首个匹配生效」：某主机块里第一个出现的 `HostName`/`User`/`Port`/`IdentityFile`
 * 生效，后续同名字段忽略（与 OpenSSH 一致，避免把后面的值当成真值）。
 */
export function parseSshConfig(text: unknown): SshConfigParseResult {
	const candidates: SshConfigCandidate[] = [];
	const skipped: SshConfigSkip[] = [];
	if (typeof text !== "string" || text.length === 0) return { candidates, skipped };
	// 只认前若干行：一份正常 config 不会到十万行，超出的部分更像误读了别的文件。
	const lines = text.split(/\r?\n/).slice(0, 20_000);
	let current: {
		/** 同一 `Host` 行的全部分别名：它们共享块的其余字段，但各成一条候选。 */
		aliases: string[];
		hostName?: string;
		user?: string;
		port?: number;
		identityFile?: string | null;
		unsupported: boolean;
		invalid: boolean;
	} | null = null;
	const seen = new Set<string>();

	const flush = () => {
		if (current === null) return;
		const block = current;
		current = null;
		const hostName = block.hostName ?? block.aliases[0] ?? "";
		const bodyInvalid = block.invalid || hostName.length === 0 || hostName.length > MAX_FIELD || !SAFE_HOST.test(hostName) || (block.user !== undefined && block.user.length > 0 && (block.user.length > MAX_FIELD || !SAFE_USER.test(block.user)));
		for (const alias of block.aliases) {
			if (WILDCARD.test(alias)) {
				// 通配块是默认值，不是主机；列出来会诱导用户添加「叫 * 的主机」。
				skipped.push({ alias, reason: "wildcard" });
				continue;
			}
			if (!aliasIsUsable(alias)) {
				// 含空白/控制字符的别名会被送进 SSH argv 与 known_hosts 别名，不能成为候选。
				skipped.push({ alias, reason: "invalid" });
				continue;
			}
			if (block.unsupported) {
				// 含 Match/Include/Proxy* 等无法在本解析器里忠实展开的指令：宁可跳过，也不给出半套语义的目标。
				skipped.push({ alias, reason: "unsupported-directive" });
				continue;
			}
			if (bodyInvalid) {
				skipped.push({ alias, reason: "invalid" });
				continue;
			}
			if (seen.has(alias) || candidates.length >= MAX_CANDIDATES) continue;
			seen.add(alias);
			candidates.push({ alias, hostName, user: block.user ?? "", port: block.port ?? null, identityFile: block.identityFile ?? null });
		}
	};

	for (const line of lines) {
		const directive = splitDirective(line);
		if (directive === null) continue;
		const key = directive.key.toLowerCase();
		if (key === "host") {
			flush();
			// 一个 Host 行可以带多个别名，它们共享同一块的其余字段。整行一次性记下，
			// 不能「先说一个再补」，否则先记的别名会在指令到达前就被结算（丢字段）。
			const aliases = directive.value.split(/\s+/).filter(Boolean);
			if (aliases.length === 0) continue;
			current = { aliases, unsupported: false, invalid: false };
			continue;
		}
		if (current === null) continue;
		switch (key) {
			case "hostname":
				if (current.hostName === undefined) current.hostName = clean(directive.value);
				break;
			case "user":
				if (current.user === undefined) current.user = clean(directive.value);
				break;
			case "port": {
				if (current.port !== undefined) break;
				const port = Number(clean(directive.value));
				if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) {
					current.port = port;
					break;
				}
				// 非法端口让整块**失效**，且与「无法展开的指令」分开记账：两者对用户的含义不同
				// （一个是配置写错，一个是本工具解析不了）。回退 22 更不行：那会连到错误的端口，
				// 失败还会被当成网络问题。
				current.invalid = true;
				break;
			}
			case "identityfile":
				if (current.identityFile === undefined) current.identityFile = clean(directive.value);
				break;
			// 这些指令会改变「连到哪里/怎么连」，本解析器无法忠实展开，因此整块跳过。
			case "match":
			case "include":
			case "proxycommand":
			case "proxyjump":
				current.unsupported = true;
				break;
			default:
				break;
		}
	}
	flush();
	return { candidates, skipped };
}

/**
 * 把候选转成用户可见的一行描述。放在这里而不是 UI 里，是为了让「缺省值如何显示」只有一处定义：
 * user 为空显示当前用户，port 为 null 显示 22，避免两个地方各写一套默认值。
 */
export function describeSshConfigCandidate(candidate: SshConfigCandidate, currentUser: string): { target: string; user: string; port: number } {
	const target = candidate.hostName;
	const user = candidate.user.length > 0 ? candidate.user : currentUser;
	const port = candidate.port ?? 22;
	return { target, user, port };
}
