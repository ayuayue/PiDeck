/**
 * PiDeck NUL Redirect Fix Extension
 *
 * Windows 上 Git Bash (MSYS2) 不把 `nul` 当作空设备，`> nul` 会创建一个名为 `nul`
 * 的真实文件。这个文件在 Windows 上是保留设备名，`ls` 看不到、编辑器打不开、
 * 常规 `rm` 删不掉——只能用 PowerShell 的 `Remove-Item -LiteralPath` 才能清理。
 *
 * 本扩展在 bash 工具执行前把 Windows 风格的 NUL 重定向改写为 `/dev/null`，
 * 遵循 shell 引号和转义规则。非 Windows 平台直接透传。
 *
 * ## 覆盖的重定向变体
 *
 * | 输入          | 改写为           |
 * |--------------|-----------------|
 * | `> nul`      | `>/dev/null`    |
 * | `> NUL`      | `>/dev/null`    |
 * | `>> nul`     | `>>/dev/null`   |
 * | `2> nul`     | `2>/dev/null`   |
 * | `2>> nul`    | `2>>/dev/null`  |
 * | `1> nul`     | `1>/dev/null`   |
 * | `&> nul`     | `&>/dev/null`   |
 * | `&>> nul`    | `&>>/dev/null`  |
 * | `>& nul`     | `>&/dev/null`   |
 *
 * ## 不处理的情况（设计如此）
 *
 * - `> nul.txt` / `> nul-backup` — 文件名含 "nul" 不是空设备引用
 * - `"echo > nul"` — 双引号/单引号内的文本
 * - `\> nul` — 反斜杠转义的重定向操作符
 * - `> "nul"` / `> 'nul'` — 引号包裹的目标（罕见，LLM 几乎不会这样写）
 *
 * ## 已知局限
 *
 * - heredoc 体内的 `> nul` 文本会被改写（概率极低）
 * - 不在 `tool_call` 之前执行的命令不受影响（如用户手动 `!` 命令）
 *
 * @packageDocumentation
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 纯函数：命令字符串重写（不依赖 pi API，便于独立测试）
// ---------------------------------------------------------------------------

/**
 * 将命令中的 Windows NUL 空设备引用改写为 /dev/null。
 *
 * 核心逻辑：
 * 1. 如果不是 win32 或命令中不含 "nul" → 直接返回（快速路径，覆盖 99%+ 场景）
 * 2. 逐字符遍历，跟踪单引号、双引号和反斜杠转义状态
 * 3. 仅在引号外且未转义的位置尝试 sticky regex 匹配重定向模式
 * 4. 匹配到的重定向保留 fd 前缀和操作符，仅替换 "nul" 为 "/dev/null"
 *
 * @param command - 原始 shell 命令
 * @returns 改写后的命令（非 Windows 或无 NUL 引用时返回原值）
 */
export function normalizeNulRedirects(command: string): string {
	// 快速路径：非 Windows 或命令中不含 "nul" 则跳过解析
	if (process.platform !== "win32") return command;
	if (!/nul/i.test(command)) return command;

	let result = "";
	let inSingleQuotes = false;
	let inDoubleQuotes = false;
	let i = 0;
	let trailingBackslashes = 0;

	// Sticky regex：仅在 lastIndex 处匹配，不会跳过未处理的字符。
	//   [12]?          — 可选 fd 数字（1 或 2）
	//   (?:&?>>?|>&)   — 重定向操作符：
	//       &?>>?       → >, >>, &>, &>>
	//       >&          → >& (csh 风格，等价于 &>)
	//   \s*            — 操作符与目标之间的可选空白
	//   nul            — 目标设备名（/iu 标志忽略大小写）
	//   (?=...)        — 前瞻：后跟空白、EOF、或控制字符（排除文件名场景）
	const redirectRe = /([12]?(?:&?>>?|>&))\s*nul(?=\s|$|[|&;()<>])/iy;

	while (i < command.length) {
		const char = command[i];

		// 反斜杠：累积计数，不做即时决定（需要看下一个字符才能判断是否转义）
		if (char === "\\") {
			trailingBackslashes++;
			result += char;
			i++;
			continue;
		}

		// 当前字符是否被奇数个反斜杠转义
		const isEscaped = trailingBackslashes % 2 === 1;
		trailingBackslashes = 0;

		// ---- 单引号状态切换 ----
		// 仅在非双引号内处理；`\'` 在引号外被视为转义，不触发引号切换
		if (char === "'" && !inDoubleQuotes) {
			if (!inSingleQuotes && isEscaped) {
				result += char;
				i++;
				continue;
			}
			inSingleQuotes = !inSingleQuotes;
			result += char;
			i++;
			continue;
		}

		// ---- 双引号状态切换 ----
		// 仅在非单引号内且未转义时切换
		if (char === '"' && !inSingleQuotes && !isEscaped) {
			inDoubleQuotes = !inDoubleQuotes;
			result += char;
			i++;
			continue;
		}

		// ---- 重定向检测 ----
		// 只在引号外且未转义时尝试匹配（引号内的 `> nul` 是字面文本，不应改写）
		if (!inSingleQuotes && !inDoubleQuotes && !isEscaped) {
			redirectRe.lastIndex = i;
			const match = redirectRe.exec(command);
			if (match) {
				// 保留 fd 前缀 + 操作符，将 "nul" 替换为 "/dev/null"
				result += `${match[1]}/dev/null`;
				i += match[0].length;
				continue;
			}
		}

		result += char;
		i++;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Pi 扩展入口
// ---------------------------------------------------------------------------

/**
 * PiDeck 内置扩展：在 bash 工具执行前改写 `> nul` 为 `> /dev/null`。
 *
 * 挂载到 `tool_call` 事件，仅处理内置 bash 工具。
 * 改写发生后通过 ctx.ui.setStatus 显示短暂提示（非阻塞，不干扰会话流）。
 */
export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const original = event.input.command;
		const normalized = normalizeNulRedirects(original);

		if (normalized !== original) {
			event.input.command = normalized;

			// 非侵入式提示：在状态栏显示改写信息，数秒后自动消失
			if (ctx.hasUI) {
				ctx.ui.setStatus("nul-fix", "NUL → /dev/null");
			}
		}
	});
}
