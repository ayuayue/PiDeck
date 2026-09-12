#!/usr/bin/env node
/**
 * 提取 0.1.5 各域 typert 描述符的端点 wire 契约（参数名/流形态），
 * 供 DshRemoteClient 适配层使用。运行：node scripts/dump-typert-endpoints.mjs
 *
 * 实现说明：描述符数组引用模块顶层的 zod schema 常量，不能只截取数组求值——
 * 把整个模块源码的 `import { z } from 'zod'` 换成 require 后整体 new Function 求值，
 * 捕获模块里的 TYPERT / TYPERT_REMOTE 导出。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const zod = require("zod");

const scope = "node_modules/@deepseek-ai";
const out = {};
for (const pkg of readdirSync(scope)) {
	const dir = join(scope, pkg, "lib");
	if (!existsSync(dir)) continue;
	for (const f of readdirSync(dir)) {
		if (!/^typert\.(host|remote-client)\.js$/.test(f)) continue;
		const path = join(dir, f);
		const src = readFileSync(path, "utf8");
		const body = src
			.replace(/^import \{ z \} from ['"]zod['"];?/m, "")
			.replace(/^export const (TYPERT_REMOTE|TYPERT) =/m, "const __OUT__ =")
			.replace(/^export default .*$/m, "")
			.replace(/^export \{[\s\S]*?\};?\s*$/m, "");
		let value;
		try {
			value = new Function("z", "require", `${body}\n;return typeof __OUT__ !== "undefined" ? __OUT__ : undefined;`)(zod.z, require);
		} catch (error) {
			console.error(`eval fail ${pkg}/${f}: ${error.message}`);
			continue;
		}
		const arr = value?.descriptors;
		if (!Array.isArray(arr)) continue;
		for (const d of arr) {
			if (!d || typeof d.id !== "string") continue;
			const endpoint = d.id.includes("#") ? d.id.slice(d.id.indexOf("#") + 1) : d.id;
			out[endpoint] = {
				pkg,
				service: d.service,
				namespace: d.namespace,
				method: d.method,
				invocation: d.invocation?.kind ?? d.invocation,
				delivery: d.delivery?.kind ?? d.delivery,
				params: (d.parameters ?? []).map((p) => ({ name: p.name, wire: p.wire, scope: p.scope })),
			};
		}
	}
}
writeFileSync(".workbuddy/typert-endpoints.json", JSON.stringify(out, null, 1));
console.log("endpoints:", Object.keys(out).length);
