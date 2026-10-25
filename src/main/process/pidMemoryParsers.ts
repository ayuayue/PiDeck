/**
 * 跨平台 pid 内存采样的纯解析函数（无 electron 依赖，可被 node --test 直接 import）。
 * 解析逻辑独立成文件的原因：系统命令输出解析是易错点（Windows CSV 千分位、
 * 单位后缀、空白处理），配单测锁定行为；运行时执行与错误处理在 ProcessMonitor。
 */

/**
 * 解析 Windows tasklist CSV 行取工作集内存（KB）：
 * `"node.exe","12345","Console","1","32,456 K"` → 第 5 列去引号、千分位逗号，得 32456。
 * 注意不能用 split(",")：千分位逗号在引号内会被拆碎（"32,456 K" → 两段），
 * 必须按引号字段提取。输入为空 / 字段不足 / 非 " K" 结尾时返回 null。
 */
export function parseTasklistMemoryKb(line: string): number | null {
	const quoted = line.match(/"([^"]*)"/g) ?? [];
	if (quoted.length < 5) return null;
	const memField = quoted[4].replace(/"/g, "").trim();
	const match = /^([\d,]+)\s*K$/.exec(memField);
	if (!match) return null;
	const kb = Number(match[1].replace(/,/g, ""));
	return Number.isFinite(kb) ? kb : null;
}

/**
 * 解析 `ps -o rss= -p N` 输出（Linux/macOS，rss 单位 KB）：
 * 输出形如 `  123456\n`。空/非数字内容返回 null。
 */
export function parsePsRssKb(output: string): number | null {
	const trimmed = output.trim();
	if (!trimmed) return null;
	const kb = Number(trimmed);
	return Number.isFinite(kb) && kb >= 0 ? kb : null;
}

/**
 * 解析 PowerShell `Get-Process -Id N -ExpandProperty PrivateMemorySize64` 输出（字节）：
 * 输出形如 `  123456789\r\n`（纯数字，无单位，可能有 BOM/CRLF）。
 * 专用工作集口径（同任务管理器"内存"列），不含共享页，避免多进程合计时共享页重复计数。
 */
export function parsePrivateMemoryBytes(output: string): number | null {
	const trimmed = output.replace(/^\uFEFF/, "").trim();
	if (!trimmed) return null;
	const bytes = Number(trimmed.replace(/,/g, ""));
	return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}
