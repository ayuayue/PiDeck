#!/usr/bin/env node
/**
 * 导出 0.1.5 typert 描述符里「我们实际调用的端点」的参数 schema 形状（必填/可选键 + 粗类型），
 * 用于批量核对 DshRemoteClient 的载荷是否与 host 侧 zod 边界校验一致。
 *
 * 背景：0.1.5 迁移期间 host 侧 zod 是 strict 校验，载荷字段名/嵌套/必填项任一处不符，
 * 都会在运行时报 `gateway/input-invalid ... wire field "x" failed boundary validation`。
 * 一轮修一个的成本极高（每次都要打包/重启才能看到下一个错），本脚本把 26 个端点的
 * 权威形状一次性打出来对照。
 *
 * 运行：node scripts/check-dsh-wire-shapes.mjs
 * 实现说明：描述符数组引用模块顶层 zod 常量，需整体求值（与 dump-typert-endpoints 同款）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const zod = require("zod");

/** 我们实际调用的端点（与 src/main/dsh/dshRemoteClient.ts 保持同步）。 */
const USED = [
	"agentPresets/deletePreset",
	"agentPresets/list",
	"credentials/describe",
	"credentials/set",
	"credentials/unset",
	"goals/create",
	"llm/discoverModels",
	"llm/listProviders",
	"session/attachment",
	"session/cancel",
	"session/create",
	"session/fork",
	"session/list",
	"session/modelCatalog",
	"session/page",
	"session/prompt",
	"session/rename",
	"session/search",
	"session/selectModel",
	"session/follow",
	"settings/describe",
	"settings/mutate",
	"settings/openSettingsDocument",
	"settings/update",
	"skills/list",
	"subagents/list",
	"workspace/create",
];

/** zod 包装层拆解：optional/nullable/default/readonly/effects。 */
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
	return { schema: current, marks, optional: marks.includes("ZodOptional") };
}

/** 粗类型描述（够判断「传错了什么」）。 */
function typeOf(schema) {
	const { schema: base, marks } = unwrap(schema);
	const def = base?._def ?? {};
	const t = def.typeName;
	if (t === "ZodObject") return "object";
	if (t === "ZodString") return "string";
	if (t === "ZodNumber") return "number";
	if (t === "ZodBoolean") return "boolean";
	if (t === "ZodArray") return "array";
	if (t === "ZodUnion" || t === "ZodDiscriminatedUnion") return "union";
	if (t === "ZodLiteral") return `literal(${JSON.stringify(def.value)})`;
	if (t === "ZodRecord") return "record";
	if (t === "ZodNull") return "null";
	if (t === "ZodAny" || t === "ZodUnknown") return "any";
	if (marks.includes("ZodReadonly")) return `${t}(ro)`;
	return t ?? "unknown";
}

function describeObject(schema) {
	const { schema: base } = unwrap(schema);
	if (base?._def?.typeName !== "ZodObject") return `(${typeOf(schema)})`;
	const shape = base._def.shape();
	const parts = [];
	for (const [key, value] of Object.entries(shape)) {
		const { optional } = unwrap(value);
		parts.push(`${key}${optional ? "?" : ""}:${typeOf(value)}`);
	}
	return `{ ${parts.join(", ")} }`;
}

const scope = "node_modules/@deepseek-ai";
const found = new Map();
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
		const arr = value?.descriptors;
		if (!Array.isArray(arr)) continue;
		for (const d of arr) {
			if (!d || typeof d.id !== "string") continue;
			const endpoint = d.id.slice(d.id.indexOf("#") + 1);
			if (!USED.includes(endpoint)) continue;
			found.set(endpoint, {
				pkg,
				delivery: d.delivery?.kind ?? d.delivery,
				params: (d.parameters ?? []).map((p) => ({
					name: p.name,
					wire: p.wire,
					// codec.mode='strict' 即 host 侧边界校验；schema 挂在 codec 下。
					mode: p.codec?.mode,
					shape: p.codec?.schema === undefined ? "(no schema)" : describeObject(p.codec.schema),
				})),
			});
		}
	}
}

for (const endpoint of USED) {
	const info = found.get(endpoint);
	if (!info) {
		console.log(`\n${endpoint}\n  ⚠ 未找到描述符（包名/端点名可能已变）`);
		continue;
	}
	console.log(`\n${endpoint}   [${info.pkg} / ${info.delivery}]`);
	for (const p of info.params) {
		console.log(`  ${p.wire ?? p.name}: ${p.shape}`);
	}
}
console.log(`\n共 ${USED.filter((e) => found.has(e)).length}/${USED.length} 个端点导出形状`);
