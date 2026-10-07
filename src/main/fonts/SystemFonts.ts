import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);

/**
 * 系统字体枚举（终端设置页的字体下拉数据源）。
 *
 * 为什么不走 `navigator.queryLocalFonts()`：Chromium 的 Local Font Access API 在
 * Electron 里既不随 `--enable-features=FontAccess` 也不随
 * `--enable-blink-features=FontAccess` 暴露（两种启动参数实测 `typeof` 仍为 undefined），
 * 且它还需要 `local-fonts` 权限与用户手势。它的数据源本身也是平台字体目录，所以这里
 * 直接读同一批目录，得到等价结果且不引入权限/实验特性依赖。
 *
 * 跨三平台策略：
 * - macOS：读 /System/Library/Fonts、/Library/Fonts、~/Library/Fonts（含 .ttc/.otf/.ttf）；
 * - Windows：PowerShell 读注册表拿真实族名（.ttc 里的多族用文件名取不到），
 *   失败则退回收录 %WINDIR%\Fonts 与用户字体目录；
 * - Linux：优先 `fc-list`（fontconfig 是权威来源），失败则退回收录目录扫描。
 *
 * 族名以**字体文件内的 name 表**为准（见 readFontFamilyName）：文件名推断会把
 * `HackNerdFont-BoldItalic` 当成一个族名，而 CSS font-family 按真实族名查找，
 * 用文件名会让下拉里一半的条目选了不生效。解析失败才退回文件名。
 *
 * 枚举失败（目录不存在、命令不可用）返回空数组而不是抛错：字体下拉退化为「跟随代码字体」
 * 一项仍可用，用户不会因为取不到字体列表而打不开设置页。
 */

/** 字体文件扩展名 → 是否为可安装字体 */
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc", ".dfont"]);

/** 样式词：字体文件名里的 weight/slant/width 标记，可连续出现（Bold Italic / BoldItalic）。 */
const FONT_STYLE_WORDS = "thin|extralight|ultralight|light|regular|book|roman|medium|semibold|demibold|demilight|bold|extrabold|ultrabold|black|heavy|italic|oblique|condensed|narrow|expanded|wide";
/**
 * 尾部样式串：`Arial Bold Italic` / `HackNerdFont-BoldItalic` / `SFNSMonoItalic` 都要剥掉，
 * 因此允许样式词之间用 `-`/`_`/空格连接，也可直接相连（BoldItalic）。
 */
const TRAILING_STYLE_PATTERN = new RegExp(`(?:[-_ ](?:${FONT_STYLE_WORDS}))+(?:[-_ ]?(?:${FONT_STYLE_WORDS}))*$`, "i");

/**
 * 从字体文件名推断族名（仅在 name 表解析失败时兜底）：
 * 去掉扩展名与尾部样式后缀。
 */
export function fontFamilyFromFileName(fileName: string): string {
	const stem = basename(fileName, extname(fileName));
	// 两个词直接相连的情况（BoldItalic）需要单独剥离：上面的模式要求样式词以 -_ 或空格起始
	const withoutConcatenated = stem.replace(new RegExp(`(?:${FONT_STYLE_WORDS})(?:${FONT_STYLE_WORDS})$`, "i"), "");
	const withoutStyle = withoutConcatenated.replace(TRAILING_STYLE_PATTERN, "").replace(/[-_ ]+$/, "");
	return (withoutStyle || stem).replace(/\s+/g, " ").trim();
}

/**
 * 只需要表目录：SFNT 跳转表在文件头 12 字节 + 16 字节/表，
 * 数百个表的字体也不超过 8KB，读 64KB 有余。
 */
const TABLE_DIRECTORY_READ_BYTES = 64 * 1024;

type NameTableRecord = { platformId: number; encodingId: number; languageId: number; nameId: number; length: number; offset: number };

/**
 * 读取字体文件的真实族名（SFNT `name` 表的 nameID 16「Typographic Family」，
 * 缺失时退回 nameID 1「Family」）。
 *
 * 为什么要解析而不用文件名：`HackNerdFont-BoldItalic.ttf` 的文件名不是族名——
 * 它的真实族名是 `Hack Nerd Font`（nameID 16）。CSS font-family 按真实族名匹配，
 * 用文件名会让下拉里相当一部分条目选中后不生效（实测 macOS 上 350 个文件里有数十个
 * 带样式后缀，全部会错）。
 *
 * 自己做 SFNT 解析而不是引第三方库：只需读 name 表的一小段（<80 行代码），
 * 而 fontkit/opentype.js 这类库体量大，为一个设置页下拉引入不值。
 *
 * 两次读取是必要的：`name` 表的位置在文件里可以很靠后（实测 HackNerdFont 在 2.5MB 处），
 * 先读表目录拿到它的偏移与长度，再只读那一小段 —— 比整文件读入省内存。
 *
 * 支持：
 * - 单字体（.ttf/.otf/.otc）：直接按 SFNT 结构解析；
 * - 字体集合（.ttc）：TTCollection 头之后每个字体各有自己的表目录，取第一个即可
 *   （设置页只需要一个族名，同集合内的族名通常一致）；
 * - macOS `.dfont`：资源叉格式，解析复杂且在新系统上已罕见 → 返回 null 走文件名兜底。
 */
export async function readFontFamilyName(filePath: string): Promise<string | null> {
	let handle;
	try {
		handle = await open(filePath, "r");
		const directory = Buffer.alloc(TABLE_DIRECTORY_READ_BYTES);
		const { bytesRead: directoryBytes } = await handle.read(directory, 0, TABLE_DIRECTORY_READ_BYTES, 0);
		const dir = directory.subarray(0, directoryBytes);
		const located = locateNameTable(dir);
		if (!located) return null;
		const nameTable = Buffer.alloc(Math.min(located.length, MAX_NAME_TABLE_BYTES));
		const { bytesRead: nameBytes } = await handle.read(nameTable, 0, nameTable.length, located.offset);
		return parseNameTable(nameTable.subarray(0, nameBytes));
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** name 表上限：涵盖真实字体（实测最大 ~13KB），同时挡住畸形表头声明的超大长度。 */
const MAX_NAME_TABLE_BYTES = 512 * 1024;

/** 从表目录里定位 `name` 表的偏移与长度（纯函数，可单测）。 */
export function locateNameTable(bytes: Buffer): { offset: number; length: number } | null {
	if (bytes.length < 12) return null;
	// .ttc：'ttcf' + version(uint32) + numFonts(uint32) + offsetTable[]，取第一个字体的表目录
	let tableDirectoryOffset = 0;
	if (bytes.readUInt32BE(0) === 0x74746366) {
		if (bytes.length < 16) return null;
		tableDirectoryOffset = bytes.readUInt32BE(12);
	}
	if (tableDirectoryOffset + 12 > bytes.length) return null;
	const tag = bytes.readUInt32BE(tableDirectoryOffset);
	// 支持的 SFNT 版本标记：TrueType(0x00010000) / 'OTTO' / 'true' / 'typ1'
	if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565 && tag !== 0x74797031) return null;
	const numTables = bytes.readUInt16BE(tableDirectoryOffset + 4);
	for (let i = 0; i < numTables; i += 1) {
		const recordOffset = tableDirectoryOffset + 12 + i * 16;
		if (recordOffset + 16 > bytes.length) return null;
		if (bytes.toString("latin1", recordOffset, recordOffset + 4) === "name") {
			const offset = bytes.readUInt32BE(recordOffset + 8);
			const length = bytes.readUInt32BE(recordOffset + 12);
			if (offset <= 0 || length <= 0) return null;
			return { offset, length };
		}
	}
	return null;
}

/** 解析已按偏移读出的 name 表（纯函数，可单测）。 */
export function parseNameTable(bytes: Buffer): string | null {
	if (bytes.length < 6) return null;
	const count = bytes.readUInt16BE(2);
	const stringOffset = bytes.readUInt16BE(4);
	const records: NameTableRecord[] = [];
	for (let i = 0; i < count; i += 1) {
		const recordOffset = 6 + i * 12;
		if (recordOffset + 12 > bytes.length) break;
		records.push({
			platformId: bytes.readUInt16BE(recordOffset),
			encodingId: bytes.readUInt16BE(recordOffset + 2),
			languageId: bytes.readUInt16BE(recordOffset + 4),
			nameId: bytes.readUInt16BE(recordOffset + 6),
			length: bytes.readUInt16BE(recordOffset + 8),
			offset: bytes.readUInt16BE(recordOffset + 10),
		});
	}
	return pickFamilyName(records, bytes, stringOffset);
}

/**
 * 从 name 记录里挑一个可用的族名。
 *
 * 优先级（同一 nameID 内）：
 * 1. platform 3（Windows）+ language 0x0409（en-US）：UTF-16BE 编码，跨平台最稳；
 * 2. 任意 platform 3（其它语言，同样 UTF-16BE）；
 * 3. platform 1（Mac）+ language 0（英文）：MacRoman/ASCII；
 * nameID 16（Typographic Family，即用户看到的完整族名）优先于 nameID 1（Family）：
 * 前者在含子族的字体里给出 `Hack Nerd Font`，后者可能只给 `Hack Nerd Font Mono`。
 */
export function pickFamilyName(records: NameTableRecord[], bytes: Buffer, stringOffset: number): string | null {
	const decode = (record: NameTableRecord): string | null => {
		const start = stringOffset + record.offset;
		const end = start + record.length;
		if (record.length === 0 || end > bytes.length) return null;
		const slice = bytes.subarray(start, end);
		if (record.platformId === 3) {
			// UTF-16BE（Windows 平台所有 name 记录都是）
			if (slice.length % 2 !== 0) return null;
			const swapped = Buffer.from(slice);
			swapped.swap16();
			return swapped.toString("utf16le");
		}
		if (record.platformId === 1) return slice.toString("latin1");
		return null;
	};
	const score = (record: NameTableRecord): number => {
		// nameID 16 优先；同 ID 时 Windows/en-US > Windows/其它 > Mac/英文
		const idScore = record.nameId === 16 ? 100 : record.nameId === 1 ? 50 : 0;
		if (idScore === 0) return 0;
		const platformScore = record.platformId === 3 ? (record.languageId === 0x0409 ? 20 : 10) : record.platformId === 1 && record.languageId === 0 ? 5 : 0;
		return idScore + platformScore;
	};
	const best = records.filter((record) => score(record) > 0).sort((a, b) => score(b) - score(a));
	for (const record of best) {
		const name = decode(record)?.replace(/\0+$/g, "").trim();
		// 族名里带 NUL / 控制字符说明解码有问题，跳过继续找下一候选
		if (name && !/[\u0000-\u001f]/.test(name)) return name;
	}
	return null;
}

async function readFontDirectory(dir: string, into: Set<string>): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		// 目录不存在/无权限：跳过该目录，其余来源继续
		return;
	}
	const files = entries.filter((entry) => entry.isFile() && FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => entry.name);
	// 并发解析 name 表：300+ 文件串行读取会明显延迟首次打开设置页；并发 16 足够掩盖 I/O 延迟
	const queue = [...files];
	const workers = Array.from({ length: Math.min(16, queue.length) }, async () => {
		for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
			const family = (await readFontFamilyName(join(dir, file))) ?? fontFamilyFromFileName(file);
			if (family) into.add(family);
		}
	});
	await Promise.all(workers);
}

/** macOS：系统字体 + 本地字体（用户安装的，如 Hack Nerd Font）。 */
async function collectMacFamilies(into: Set<string>): Promise<void> {
	await readFontDirectory("/System/Library/Fonts", into);
	await readFontDirectory("/System/Library/Fonts/Supplemental", into);
	await readFontDirectory("/Library/Fonts", into);
	await readFontDirectory(join(app.getPath("home"), "Library", "Fonts"), into);
}

/**
 * Windows：PowerShell 读注册表拿真实族名（.ttc 里的多族用文件名取不到）。
 * 拿不到时退回收录 %WINDIR%\Fonts 的文件名。
 */
async function collectWindowsFamilies(into: Set<string>): Promise<void> {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' | Select-Object -Property * -ExcludeProperty PS* | ForEach-Object { $_.PSObject.Properties | ForEach-Object { $_.Name -replace '\\s*\\(.*\\)$','' } }"],
			{ timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
		);
		for (const line of stdout.split(/\r?\n/)) {
			const name = line.trim().replace(/\s*\(.*\)$/, "");
			// 注册表键名形如 "Arial Bold (TrueType)"；去掉样式后缀得到族名
			if (name) into.add(fontFamilyFromFileName(name));
		}
	} catch {
		// PowerShell 不可用/被策略拦：走文件名兜底
	}
	const windir = process.env.WINDIR ?? process.env.SystemRoot;
	if (windir) await readFontDirectory(join(windir, "Fonts"), into);
	// 当前用户安装的字体（Win10+ 无管理员权限安装）
	if (process.env.LOCALAPPDATA) await readFontDirectory(join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"), into);
}

/** Linux：fontconfig 的 `fc-list` 是权威来源（含字体别名与用户目录）。 */
async function collectLinuxFamilies(into: Set<string>): Promise<void> {
	try {
		const { stdout } = await execFileAsync("fc-list", [":", "family"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
		for (const line of stdout.split(/\r?\n/)) {
			// 一行可能是 "Noto Sans CJK SC,思源黑体"：逗号分隔的别名都作为候选
			for (const family of line.split(",")) {
				const name = family.trim();
				if (name) into.add(name);
			}
		}
	} catch {
		// 无 fc-list（精简发行版）：走目录兜底
	}
	await readFontDirectory("/usr/share/fonts", into);
	await readFontDirectory("/usr/local/share/fonts", into);
	await readFontDirectory(join(app.getPath("home"), ".local", "share", "fonts"), into);
	await readFontDirectory(join(app.getPath("home"), ".fonts"), into);
}

/**
 * 列出系统已安装字体族（去重、排序、大小写不敏感）。
 * 结果缓存进程内一次：字体在运行期几乎不会变，而枚举需要多次目录扫描/子进程调用。
 */
let cachedFamilies: string[] | null = null;

export async function listSystemFontFamilies(options: { refresh?: boolean } = {}): Promise<string[]> {
	if (cachedFamilies && !options.refresh) return cachedFamilies;
	const families = new Set<string>();
	if (process.platform === "darwin") await collectMacFamilies(families);
	else if (process.platform === "win32") await collectWindowsFamilies(families);
	else await collectLinuxFamilies(families);
	cachedFamilies = [...families]
		.filter((name) => name.length > 0 && name.length <= 80)
		// 过滤系统内部字体：macOS 用 `.` 前缀标记私有族名（`.LastResort` 每个码位都是
		// 方框、`.Keyboard`/`.Aqua Kana`/`.SF NS *` 只服务系统 UI），Font Book 与本机
		// 字体面板都不展示它们。实测本机 314 个族名里 22 个是这类，留在下拉里纯属噪音，
		// 选中 `.LastResort` 更是让终端整屏变方框。`@` 前缀是 macOS 的本地化别名
		// （如 `@宋体`），同属不可直接选用的名字，一并剔除。
		.filter((name) => !name.startsWith(".") && !name.startsWith("@"))
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	return cachedFamilies;
}

/** 清空缓存（测试用；正常运行时无需调用）。 */
export function resetSystemFontCache(): void {
	cachedFamilies = null;
}
