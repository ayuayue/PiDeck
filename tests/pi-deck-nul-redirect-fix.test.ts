/**
 * `normalizeNulRedirects` 纯函数的独立测试。
 *
 * 运行方式（需要 Node 18+ 原生 TypeScript 支持或 tsx）：
 *   npx tsx resources/extensions/pi-deck-nul-redirect-fix.test.ts
 */

// =========================================================================
// 纯函数副本（与 pi-deck-nul-redirect-fix.ts 保持同步，避免引入 pi 依赖）
// =========================================================================

function normalizeNulRedirects(command: string): string {
	if (process.platform !== "win32") return command;
	if (!/nul/i.test(command)) return command;

	let result = "";
	let inSingleQuotes = false;
	let inDoubleQuotes = false;
	let i = 0;
	let trailingBackslashes = 0;

	const redirectRe = /([12]?(?:&?>>?|>&))\s*nul(?=\s|$|[|&;()<>])/iy;

	while (i < command.length) {
		const char = command[i];

		if (char === "\\") {
			trailingBackslashes++;
			result += char;
			i++;
			continue;
		}

		const isEscaped = trailingBackslashes % 2 === 1;
		trailingBackslashes = 0;

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

		if (char === '"' && !inSingleQuotes && !isEscaped) {
			inDoubleQuotes = !inDoubleQuotes;
			result += char;
			i++;
			continue;
		}

		if (!inSingleQuotes && !inDoubleQuotes && !isEscaped) {
			redirectRe.lastIndex = i;
			const match = redirectRe.exec(command);
			if (match) {
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

// =========================================================================
// 测试用例
// =========================================================================

interface TestCase {
	name: string;
	input: string;
	expected: string;
}

const testCases: TestCase[] = [
	// ---- 基础 ----
	{ name: "空字符串", input: "", expected: "" },
	{ name: "无 nul 不变", input: "echo hello", expected: "echo hello" },
	{ name: "grep nul 不是重定向", input: "grep nul file.txt", expected: "grep nul file.txt" },
	{ name: "echo nul 不含重定向", input: "echo nul", expected: "echo nul" },
	{ name: "echo null value", input: "echo null value", expected: "echo null value" },

	// ---- stdout 覆盖 ----
	{ name: "> nul", input: "echo hello > nul", expected: "echo hello >/dev/null" },
	{ name: ">NUL (大写)", input: "echo hello >NUL", expected: "echo hello >/dev/null" },
	{ name: ">Nul (混合)", input: "echo hello >Nul", expected: "echo hello >/dev/null" },
	{ name: ">  nul (多空格)", input: "echo hello >  nul", expected: "echo hello >/dev/null" },
	{ name: ">nul (无空格)", input: "echo hello >nul", expected: "echo hello >/dev/null" },

	// ---- stdout 追加 ----
	{ name: ">> nul", input: "echo hello >> nul", expected: "echo hello >>/dev/null" },
	{ name: ">>  NUL", input: "echo hello >>  NUL", expected: "echo hello >>/dev/null" },

	// ---- fd 前缀 ----
	{ name: "1> nul", input: "echo hello 1> nul", expected: "echo hello 1>/dev/null" },
	{ name: "2> nul", input: "echo hello 2> nul", expected: "echo hello 2>/dev/null" },
	{ name: "1>> nul", input: "echo hello 1>> nul", expected: "echo hello 1>>/dev/null" },
	{ name: "2>> nul", input: "echo hello 2>> nul", expected: "echo hello 2>>/dev/null" },

	// ---- &> / &>> ----
	{ name: "&> nul", input: "echo hello &> nul", expected: "echo hello &>/dev/null" },
	{ name: "&>  Nul", input: "echo hello &>  Nul", expected: "echo hello &>/dev/null" },
	{ name: "&>> nul", input: "echo hello &>> nul", expected: "echo hello &>>/dev/null" },
	{ name: "&>>  NuL", input: "echo hello &>>  NuL", expected: "echo hello &>>/dev/null" },

	// ---- >& (csh-style) — 本次改进新增 ----
	{ name: ">& nul", input: "echo hello >& nul", expected: "echo hello >&/dev/null" },
	{ name: ">&nul", input: "echo hello >&nul", expected: "echo hello >&/dev/null" },
	{ name: ">&  NUL", input: "echo hello >&  NUL", expected: "echo hello >&/dev/null" },

	// ---- 多重重定向 ----
	{ name: "两个 > nul", input: "echo a > nul && echo b > nul", expected: "echo a >/dev/null && echo b >/dev/null" },

	// ---- 控制字符边界 ----
	{ name: "管道后", input: "echo hello > nul|cat", expected: "echo hello >/dev/null|cat" },
	{ name: "分号后", input: "echo hello > nul;echo done", expected: "echo hello >/dev/null;echo done" },
	{ name: "括号后", input: "echo hello > nul(extra", expected: "echo hello >/dev/null(extra" },

	// ---- 裸重定向 ----
	{ name: ">nul 裸", input: ">nul", expected: ">/dev/null" },
	{ name: "> nul 裸", input: "> nul", expected: ">/dev/null" },

	// ---- 不应重写：文件名场景 ----
	{ name: "> nul.txt", input: "echo data > nul.txt", expected: "echo data > nul.txt" },
	{ name: "> nul-backup", input: "echo data > nul-backup", expected: "echo data > nul-backup" },
	{ name: "> nul_suffix", input: "echo data > nul_suffix", expected: "echo data > nul_suffix" },
	{ name: "> null_file", input: "echo data > null_file", expected: "echo data > null_file" },

	// ---- 不应重写：引号内 ----
	{ name: '双引号内 > nul', input: 'echo "foo > nul bar"', expected: 'echo "foo > nul bar"' },
	{ name: '双引号内嵌套单引号', input: 'echo "foo \'bar > nul baz\'"', expected: 'echo "foo \'bar > nul baz\'"' },
	{ name: "单引号内 > nul", input: "echo 'foo > nul bar'", expected: "echo 'foo > nul bar'" },

	// ---- 转义 ----
	{ name: "转义的 > (奇数反斜杠)", input: "echo \\> nul", expected: "echo \\> nul" },
	{ name: "未转义 (偶数反斜杠)", input: "echo \\\\> nul", expected: "echo \\\\>/dev/null" },
	{ name: "3反斜杠转义", input: "echo \\\\\\> nul", expected: "echo \\\\\\> nul" },
	{ name: "4反斜杠未转义", input: "echo \\\\\\\\> nul", expected: "echo \\\\\\\\>/dev/null" },
	{ name: "6反斜杠未转义", input: "echo \\\\\\\\\\\\> nul", expected: "echo \\\\\\\\\\\\>/dev/null" },

	// ---- fd 与操作符空格分离 ----
	{ name: "1 > nul (空格)", input: "echo hello 1 > nul", expected: "echo hello 1 >/dev/null" },
	{ name: "2  >  nul", input: "echo hello 2  >  nul", expected: "echo hello 2  >/dev/null" },
	{ name: "2 >>  nul", input: "echo hello 2 >>  nul", expected: "echo hello 2 >>/dev/null" },

	// ---- 混合引号 ----
	{ name: "混合单双引号外重写", input: "echo 'a' \"b\" > nul", expected: "echo 'a' \"b\" >/dev/null" },
	{ name: "单引号内含双引号不重写", input: "echo 'a \"b\" c' > nul", expected: "echo 'a \"b\" c' >/dev/null" },

	// ---- 2>&1 组合 ----
	{ name: "2>&1 > nul", input: "cmd 2>&1 > nul", expected: "cmd 2>&1 >/dev/null" },
	{ name: "2>&1 单独不匹配", input: "cmd 2>&1", expected: "cmd 2>&1" },

	// ---- 转义引号 ----
	{ name: "转义双引号外重写", input: 'echo \\"foo > nul bar\\"', expected: 'echo \\"foo >/dev/null bar\\"' },
	{ name: "双引号内转义双引号不重写", input: 'echo "foo \\"bar > nul baz"', expected: 'echo "foo \\"bar > nul baz"' },

	// ---- 反斜杠后单引号 ----
	{ name: "反斜杠+单引号结束引号上下文", input: "echo 'foo\\\\' > nul", expected: "echo 'foo\\\\' >/dev/null" },
];

// =========================================================================
// 运行测试
// =========================================================================

let passed = 0;
let failed = 0;

for (const { name, input, expected } of testCases) {
	const result = normalizeNulRedirects(input);
	if (result === expected) {
		passed++;
	} else {
		failed++;
		console.error(`FAIL: ${name}`);
		console.error(`  input:    ${JSON.stringify(input)}`);
		console.error(`  expected: ${JSON.stringify(expected)}`);
		console.error(`  got:      ${JSON.stringify(result)}`);
	}
}

// ---- 非 Windows 平台透传测试 ----
if (process.platform === "win32") {
	const saved = process.platform;
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	try {
		const t1 = normalizeNulRedirects("echo hello > nul") === "echo hello > nul";
		const t2 = normalizeNulRedirects("echo hello 2>> nul") === "echo hello 2>> nul";
		const t3 = normalizeNulRedirects("echo hello &>> nul") === "echo hello &>> nul";
		const t4 = normalizeNulRedirects("echo hello >& nul") === "echo hello >& nul";
		if (t1 && t2 && t3 && t4) {
			passed += 4;
		} else {
			failed += 4;
			console.error("FAIL: non-Windows no-op tests");
		}
	} finally {
		Object.defineProperty(process, "platform", { value: saved, configurable: true });
	}
} else {
	// 非 Windows 环境：所有命令应原样返回
	for (const { name, input, expected } of testCases) {
		if (input === "" || input === expected) continue;
		const result = normalizeNulRedirects(input);
		if (result === input) {
			passed++;
		} else {
			failed++;
			console.error(`FAIL (non-Win no-op): ${name} | got ${JSON.stringify(result)}`);
		}
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
