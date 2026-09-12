#!/usr/bin/env node
/**
 * 校验 DshRemoteClient 的每个 RPC 调用载荷是否满足 host 侧 typert 描述符的边界校验。
 *
 * 为什么需要（0.1.5 迁移经验）：host 侧 gateway 对载荷做两道强校验——
 *   1. args 的键集必须与描述符 wires 精确一致（多一个/少一个 → gateway/arguments-invalid）；
 *   2. 每个 wire 的值按 zod strict schema.parse（少必填/类型不符 → gateway/input-invalid
 *      ... failed boundary validation）。
 * 迁移期这两类错误一个要打包重启才浮现一个，成本极高。本脚本静态读出
 * dshRemoteClient.ts 的调用点载荷（顶层键 + 一层嵌套键），与描述符 schema 比对后
 * 一次性列出全部问题。
 *
 * 运行：node scripts/check-dsh-wire-payloads.mjs
 * 退出码：0 = 全部通过；1 = 存在不符（CI/本地门禁可直接用）。
 *
 * 局限（有意为之）：只做**静态**判据。展开表达式（`...(cond ? {a} : {})`）视为
 * 「可选补充」，不参与「多键」判断；动态端点（endpoint 变量）跳过并提示。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const zod = require("zod");
const root = resolve(import.meta.dirname, "..");
const clientPath = join(root, "src/main/dsh/dshRemoteClient.ts");

// ── 1. 从描述符抽取 host 侧契约（wire + schema） ──────────────────────────────

const scope = join(root, "node_modules/@deepseek-ai");
const contracts = new Map();
for (const pkg of readdirSync(scope)) {
	const dir = join(scope, pkg, "lib");
	if (!existsSync(dir)) continue;
	for (const f of readdirSync(dir)) {
		if (!/^typert\.(host|remote-client)\.js$/.test(f)) continue;
		const src = readFileSync(join(dir, f), "utf8");
		const body = src
			.replace(/^import \{ z \} from ['"]zod['"];?/m, "")
			.replace(/^export const (TYPERT_REMOTE|TYPERT) =/m, "const __OUT__ =")
			.replace(/^export default .*$/m, "")
			.replace(/^export \{[\s\S]*?\};?\s*$/m, "");
		let value;
		try {
			value = new Function("z", `${body}\nreturn __OUT__;`)(zod);
		} catch {
			continue;
		}
		if (!Array.isArray(value?.descriptors)) continue;
		for (const d of value.descriptors) {
			if (typeof d?.id !== "string") continue;
			const endpoint = d.id.slice(d.id.indexOf("#") + 1);
			contracts.set(endpoint, {
				pkg,
				wires: (d.parameters ?? []).map((p) => ({
					wire: p.wire,
					acceptsUndefined: p.acceptsUndefined === true || p.codec?.mode === "src-json",
					schema: p.codec?.schema,
				})),
			});
		}
	}
}

// ── 2. 从调用点抽载荷（顶层键 + 一层嵌套对象键） ────────────────────────────

/** 取 `(` 后第一个对象字面量的源码文本（花括号配平；忽略字符串里的括号）。 */
function extractObjectLiteral(source, openIndex) {
	let depth = 0;
	let quote = "";
	for (let i = openIndex; i < source.length; i += 1) {
		const ch = source[i];
		if (quote) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{" || ch === "[" || ch === "(") depth += 1;
		else if (ch === "}" || ch === "]" || ch === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(openIndex, i + 1);
		}
	}
	return undefined;
}

/** 去掉行/块注释（保留字符串内的 //），避免注释文本被当成键名。 */
function stripComments(text) {
	let out = "";
	let quote = "";
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote) {
			out += ch;
			if (ch === "\\") {
				out += text[i + 1] ?? "";
				i += 1;
			} else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			out += "\n";
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i += 1;
			continue;
		}
		out += ch;
	}
	return out;
}

/** 对象字面量的顶层键（展开项单独记录为 optional）。 */
function topLevelKeys(literal) {
	const body = stripComments(literal.slice(1, -1));
	const keys = [];
	const spreads = [];
	let depth = 0;
	let quote = "";
	let token = "";
	let expectKey = true;
	const flush = () => {
		const text = token.trim();
		token = "";
		if (!text) return;
		if (text.startsWith("...")) {
			spreads.push(text);
			return;
		}
		// `key:` / `"key":` / `key,`（简写属性）
		const m = /^["']?([A-Za-z0-9_$-]+)["']?\s*(?::|$)/.exec(text);
		if (m) keys.push(m[1]);
	};
	for (let i = 0; i < body.length; i += 1) {
		const ch = body[i];
		if (quote) {
			token += ch;
			if (ch === "\\") {
				token += body[i + 1] ?? "";
				i += 1;
			} else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			token += ch;
			continue;
		}
		if (ch === "{" || ch === "[" || ch === "(") {
			depth += 1;
			token = "";
			expectKey = false;
			continue;
		}
		if (ch === "}" || ch === "]" || ch === ")") {
			depth -= 1;
			token = "";
			continue;
		}
		if (depth === 0 && ch === ",") {
			// 只在「期待键」的位置把 token 当键；否则它是上一个键的值（如 agentId: sessionId）。
			if (expectKey) flush();
			else token = "";
			expectKey = true;
			continue;
		}
		if (depth === 0 && ch === ":") {
			// 键结束：token 就是键名
			flush();
			expectKey = false;
			continue;
		}
		if (depth === 0 && expectKey) token += ch;
		else if (depth === 0) token = "";
	}
	flush();
	return { keys, spreads };
}

/** 找到 wire 对应的嵌套对象字面量（`request: { ... }` 里的花括号起点）。 */
function nestedLiteralFor(literal, key) {
	const re = new RegExp(`(^|[,{\\s])["']?${key}["']?\\s*:\\s*\\{`);
	const m = re.exec(literal);
	if (!m) return undefined;
	const braceIndex = literal.indexOf("{", m.index + m[0].length - 1);
	return braceIndex < 0 ? undefined : extractObjectLiteral(literal, braceIndex);
}

const source = readFileSync(clientPath, "utf8");
const callSites = [];
const callRe = /\.(?:call|openStream)\(\s*(?:`([^`]+)`|"([^"]+)"|([A-Za-z_$][\w$]*))\s*,/g;
let match;
while ((match = callRe.exec(source)) !== null) {
	const endpoint = match[1] ?? match[2] ?? null;
	const dynamic = match[3] ?? null;
	const afterComma = match.index + match[0].length;
	const literalStart = source.indexOf("{", afterComma);
	const literal =
		literalStart >= 0 && literalStart - afterComma < 30 ? extractObjectLiteral(source, literalStart) : undefined;
	callSites.push({ endpoint, dynamic, literal, line: source.slice(0, match.index).split("\n").length });
}

// ── 3. 比对 ────────────────────────────────────────────────────────────────

function unwrap(schema) {
	let current = schema;
	const marks = [];
	for (let i = 0; i < 8; i += 1) {
		const def = current?._def;
		if (!def?.typeName) break;
		marks.push(def.typeName);
		const inner = def.innerType ?? def.schema ?? def.type;
		if (!inner || inner === current) break;
		current = inner;
	}
	return { schema: current, optional: marks.includes("ZodOptional") };
}

/** schema 的必填键（zodObject.shape 中非 optional 的键）。 */
function requiredKeys(schema) {
	const { schema: base } = unwrap(schema);
	if (base?._def?.typeName !== "ZodObject") return undefined;
	const shape = base._def.shape();
	return Object.entries(shape)
		.filter(([, v]) => !unwrap(v).optional)
		.map(([k]) => k);
}

let failures = 0;
let checked = 0;
const skipped = [];

for (const site of callSites) {
	if (site.dynamic !== null) {
		skipped.push(`行 ${site.line}: 动态端点 ${site.dynamic}（需人工核对）`);
		continue;
	}
	// $events 是 gateway 特例：无 typert 描述符，要求载荷为 { args: {} }（见 gateway
	// openRemoteEvents 的显式校验），由 DshApiClient 的出口包装满足，无需描述符比对。
	if (site.endpoint === "$events") {
		skipped.push(`行 ${site.line}: $events（gateway 特例，要求空 args）`);
		continue;
	}
	const contract = contracts.get(site.endpoint);
	if (!contract) {
		failures += 1;
		console.log(`✗ ${site.endpoint} (行 ${site.line}): 描述符里没有这个端点`);
		continue;
	}
	if (!site.literal) {
		skipped.push(`行 ${site.line}: ${site.endpoint} 载荷非对象字面量`);
		continue;
	}
	checked += 1;
	const { keys, spreads } = topLevelKeys(site.literal);
	const expected = new Set(contract.wires.map((w) => w.wire));
	const acceptsMissing = new Set(contract.wires.filter((w) => w.acceptsUndefined).map((w) => w.wire));
	const problems = [];

	const extra = keys.filter((k) => !expected.has(k));
	if (extra.length > 0) problems.push(`多余顶层键 ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
	const missing = [...expected].filter((k) => !keys.includes(k) && !acceptsMissing.has(k) && spreads.length === 0);
	if (missing.length > 0) problems.push(`缺少顶层键 ${missing.map((k) => JSON.stringify(k)).join(", ")}`);

	// 一层嵌套：wire 的值是对象字面量时，比对 schema 必填键
	for (const wire of contract.wires) {
		if (!keys.includes(wire.wire)) continue;
		const nested = nestedLiteralFor(site.literal, wire.wire);
		if (!nested) continue;
		const required = requiredKeys(wire.schema);
		if (!required) continue;
		const nestedKeys = topLevelKeys(nested).keys;
		const nestedMissing = required.filter((k) => !nestedKeys.includes(k));
		if (nestedMissing.length > 0) {
			problems.push(`${wire.wire} 缺少必填字段 ${nestedMissing.map((k) => JSON.stringify(k)).join(", ")}`);
		}
	}

	if (problems.length > 0) {
		failures += 1;
		console.log(`✗ ${site.endpoint} (行 ${site.line}): ${problems.join("；")}`);
	}
}

console.log(`\n已校验 ${checked} 个调用点，不符 ${failures} 个`);
for (const note of skipped) console.log(`  跳过 ${note}`);
process.exit(failures > 0 ? 1 : 0);
