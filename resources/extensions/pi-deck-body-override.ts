/**
 * PiDeck Body Override Extension
 *
 * pi 的 models.json schema 没有"自定义请求体"字段,但 TypeBox 校验默认放行未知
 * 字段。PiDeck 的可视化表单把每个 provider / model 的
 *   body     —— 内联 JSON 对象
 *   bodyFile —— 本地 JSON 文件路径(相对路径基于 ~/.pi/agent/)
 * 直接写进 models.json。本扩展用 before_provider_request 钩子(payload 构建后、
 * 发送前触发,返回值整体替换请求体)把这些字段深合并进请求体。
 *
 * models.json 示例:
 * {
 *   "providers": {
 *     "Kimi Code": {
 *       "body": { "temperature": 0.6 },          // provider 级内联
 *       "bodyFile": "C:/extra/kimi-body.json",   // provider 级文件
 *       "models": [
 *         { "id": "k3", ..., "body": { "top_p": 0.9 }, "bodyFile": "./k3.json" }
 *       ]
 *     }
 *   }
 * }
 *
 * 合并顺序:provider.body → provider.bodyFile → model.body → model.bodyFile,
 * 后者覆盖前者。深合并:嵌套对象递归合并,数组与标量整体替换。
 * 每次请求按 mtime 重读 models.json / bodyFile,PiDeck 保存后即时生效。
 *
 * 注意:payload 是该 provider API 类型序列化后的格式(如 anthropic-messages),
 * 要写的字段必须匹配对应 API 的请求体结构。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const MODELS_JSON = path.join(AGENT_DIR, "models.json");

type JsonObject = Record<string, unknown>;

interface BodyTarget {
	body?: unknown;
	bodyFile?: unknown;
}

interface ModelsFile {
	providers?: Record<string, BodyTarget & { models?: BodyTarget & { id?: unknown }[] }>;
}

let cachedModels: ModelsFile | undefined;
let cachedMtimeMs = -1;
let lastError: string | undefined;

function readJsonFile(filePath: string): JsonObject | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
	} catch (err) {
		lastError = `${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`;
		return undefined;
	}
}

function loadModelsFile(): ModelsFile | undefined {
	let mtimeMs = -1;
	try {
		mtimeMs = fs.statSync(MODELS_JSON).mtimeMs;
	} catch {
		cachedModels = undefined;
		cachedMtimeMs = -1;
		return undefined;
	}
	if (mtimeMs === cachedMtimeMs) return cachedModels;
	const parsed = readJsonFile(MODELS_JSON);
	cachedModels = parsed as ModelsFile | undefined;
	cachedMtimeMs = mtimeMs;
	return cachedModels;
}

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** body 必须是对象;非法值(字符串/数组等)忽略并报一次错。 */
function asBody(v: unknown, where: string): JsonObject | undefined {
	if (v === undefined || v === null) return undefined;
	if (!isPlainObject(v)) {
		lastError = `${where}: body 必须是 JSON 对象`;
		return undefined;
	}
	return v;
}

function loadBodyFile(target: BodyTarget): JsonObject | undefined {
	if (typeof target.bodyFile !== "string" || !target.bodyFile.trim()) return undefined;
	const p = path.isAbsolute(target.bodyFile)
		? target.bodyFile
		: path.join(AGENT_DIR, target.bodyFile);
	return readJsonFile(p);
}

function deepMerge(base: unknown, extra: unknown): unknown {
	if (isPlainObject(base) && isPlainObject(extra)) {
		const out: JsonObject = { ...base };
		for (const [k, v] of Object.entries(extra)) {
			out[k] = k in out ? deepMerge(out[k], v) : v;
		}
		return out;
	}
	return extra; // 数组 / 标量 / null:整体替换
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		lastError = undefined;
		const config = loadModelsFile();
		if (!config?.providers || !ctx.model) return undefined;

		const provider = config.providers[ctx.model.provider];
		if (!provider) return undefined;

		const modelEntry = Array.isArray(provider.models)
			? provider.models.find((m) => m && m.id === ctx.model!.id)
			: undefined;

		const layers: (JsonObject | undefined)[] = [
			asBody(provider.body, `${ctx.model.provider}.body`),
			loadBodyFile(provider),
			modelEntry ? asBody(modelEntry.body, `${ctx.model.provider}/${ctx.model.id}.body`) : undefined,
			modelEntry ? loadBodyFile(modelEntry) : undefined,
		];

		let payload = event.payload;
		let touched = false;
		for (const layer of layers) {
			if (!layer) continue;
			payload = deepMerge(payload, layer);
			touched = true;
		}
		if (lastError) ctx.ui.notify(`body-override: ${lastError}`, "warning");
		return touched ? payload : undefined;
	});
}
