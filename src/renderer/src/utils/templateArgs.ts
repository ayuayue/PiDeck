/**
 * 提示词模板的参数解析与占位替换——**逐条照搬 pi 的实现**。
 *
 * 来源：`@earendil-works/pi-coding-agent/dist/core/prompt-templates.js` 的
 * `parseCommandArgs` / `substituteArgs`。为什么不自己发明一套：模板作者写 `$1` `$@`
 * 时用的是 pi 的语义，PiDeck 本地展开（为了保住模板名 → chip）必须产出**一样的正文**，
 * 否则同一个模板在「PiDeck 展开」和「pi 展开」两条路上给出不同 prompt。
 *
 * 支持的语法（与 pi 一致）：
 * - `$1` `$2` …            按位置取参数，缺失为空串
 * - `$@` / `$ARGUMENTS`    全部参数（空格连接）
 * - `${1:-默认}`           位置参数缺失/为空时用默认值
 * - `${@:-默认}`           全部参数为空时用默认值
 * - `${@:2}`               从第 2 个参数开始
 * - `${@:2:3}`             从第 2 个开始取 3 个
 *
 * pi 明确保证的两个边界（这里同样成立）：
 * 1. 只替换**模板串**，参数内容里的 `$1` / `$@` 不会被二次展开；
 * 2. 位置越界取空串，不抛错。
 */

/** bash 风格切词：支持单/双引号，引号内的空格不切；`""` 这种空引号算一个空参数。 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// 记录「已经开始的 token」：`""` 这种引号空串也要产出一个参数
	let hasToken = false;
	let inQuote: string | null = null;
	for (let i = 0; i < argsString.length; i += 1) {
		const char = argsString[i] as string;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			hasToken = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}
		current += char;
		hasToken = true;
	}
	if (hasToken) args.push(current);
	return args;
}

const PLACEHOLDER_RE = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

/** 模板正文是否含参数占位（用于区分「参数已被模板消费」和「参数要追加在块后」）。 */
export function hasArgPlaceholders(content: string): boolean {
	PLACEHOLDER_RE.lastIndex = 0;
	const hit = PLACEHOLDER_RE.test(content);
	PLACEHOLDER_RE.lastIndex = 0;
	return hit;
}

/** 把模板正文里的占位替换成参数（单次遍历，不对替换结果再扫描）。 */
export function substituteArgs(content: string, args: readonly string[]): string {
	const allArgs = args.join(" ");
	return content.replace(PLACEHOLDER_RE, (_match, defaultTarget: string, defaultValue: string, sliceStart: string, sliceLength: string, simple: string) => {
		if (defaultTarget) {
			const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[Number.parseInt(defaultTarget, 10) - 1];
			return value ? value : defaultValue;
		}
		if (sliceStart) {
			// bash 习惯：参数从 1 开始计数，0 按 1 处理
			let start = Number.parseInt(sliceStart, 10) - 1;
			if (start < 0) start = 0;
			if (sliceLength) {
				const length = Number.parseInt(sliceLength, 10);
				return args.slice(start, start + length).join(" ");
			}
			return args.slice(start).join(" ");
		}
		if (simple === "ARGUMENTS" || simple === "@") return allArgs;
		const index = Number.parseInt(simple, 10) - 1;
		return args[index] ?? "";
	});
}
