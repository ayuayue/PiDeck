import assert from "node:assert/strict";
import test from "node:test";

/**
 * 生视频协议适配器（纯函数）：构包/解析/状态归一/错误抽取。
 * 这些函数承载「各家方言收敛」的核心逻辑，必须脱离网络可测。
 */

const { loadTsCommonJs } = await import("./helpers/loadTsCommonJs.mjs");
const adapters = loadTsCommonJs("src/main/videogen/videoAdapters.ts");

test("parseVideoDurationSeconds：合法 1-30 秒，非法/越界返回 undefined", () => {
	assert.equal(adapters.parseVideoDurationSeconds("5"), 5);
	assert.equal(adapters.parseVideoDurationSeconds(" 10 "), 10);
	assert.equal(adapters.parseVideoDurationSeconds("0"), undefined);
	assert.equal(adapters.parseVideoDurationSeconds("31"), undefined);
	assert.equal(adapters.parseVideoDurationSeconds("abc"), undefined);
	assert.equal(adapters.parseVideoDurationSeconds(undefined), undefined);
});

test("normalizeVideoTaskStatus：方言同义词压平（含 MiniMax 官方拼写错误 succuess）", () => {
	assert.equal(adapters.normalizeVideoTaskStatus("succuess"), "succeeded");
	assert.equal(adapters.normalizeVideoTaskStatus("SUCCEED"), "succeeded");
	assert.equal(adapters.normalizeVideoTaskStatus("succeeded"), "succeeded");
	assert.equal(adapters.normalizeVideoTaskStatus("processing"), "running");
	assert.equal(adapters.normalizeVideoTaskStatus("pending"), "queued");
	assert.equal(adapters.normalizeVideoTaskStatus("error"), "failed");
	assert.equal(adapters.normalizeVideoTaskStatus("weird-value"), undefined);
	assert.equal(adapters.normalizeVideoTaskStatus(42), undefined);
});

test("buildVideoSubmitRequest：minimax-v2 路径 + 参数序列化（duration 转数字、缺省字段不发）", () => {
	const request = adapters.buildVideoSubmitRequest("minimax-v2", {
		baseUrl: "https://gw.example.com/",
		apiKey: " sk-1 ",
		model: "minimax-h3-max",
		prompt: "一只猫在弹钢琴",
		resolution: "480P",
		duration: "5",
		ratio: "16:9",
	});
	assert.equal(request.url, "https://gw.example.com/gateway/minimax/v2/video_generation");
	assert.equal(request.headers.Authorization, "Bearer sk-1");
	assert.equal(request.headers["Content-Type"], "application/json");
	const body = JSON.parse(request.body);
	assert.equal(body.model, "minimax-h3-max");
	assert.deepEqual([...body.content], [{ type: "text", text: "一只猫在弹钢琴" }]);
	assert.equal(body.resolution, "480P");
	assert.equal(body.duration, 5);
	assert.equal(body.ratio, "16:9");
});

test("buildVideoSubmitRequest：可选参数缺省时不发字段（避免未知字段 400）", () => {
	const request = adapters.buildVideoSubmitRequest("minimax-v2", {
		baseUrl: "https://gw.example.com",
		apiKey: "sk-1",
		model: "m",
		prompt: "p",
	});
	const body = JSON.parse(request.body);
	assert.equal("resolution" in body, false);
	assert.equal("duration" in body, false);
	assert.equal("ratio" in body, false);
});

test("buildVideoSubmitRequest：分辨率大小写按协议族归一（minimax 大写 / ark 小写）", () => {
	const minimax = JSON.parse(
		adapters.buildVideoSubmitRequest("minimax-v2", {
			baseUrl: "https://gw.example.com",
			apiKey: "sk-1",
			model: "m",
			prompt: "p",
			resolution: "480p",
		}).body,
	);
	const ark = JSON.parse(
		adapters.buildVideoSubmitRequest("seedance-ark", {
			baseUrl: "https://gw.example.com",
			apiKey: "sk-1",
			model: "m",
			prompt: "p",
			resolution: "720P",
		}).body,
	);
	assert.equal(minimax.resolution, "480P");
	assert.equal(ark.resolution, "720p");
});

test("buildVideoSubmitRequest：seedance-ark 走 ark 路径", () => {
	const request = adapters.buildVideoSubmitRequest("seedance-ark", {
		baseUrl: "https://gw.example.com//",
		apiKey: "sk-1",
		model: "seedance-1",
		prompt: "p",
		duration: "10",
	});
	assert.equal(request.url, "https://gw.example.com/gateway/ark/v3/generations/tasks");
	assert.equal(JSON.parse(request.body).duration, 10);
});

test("buildVideoQueryRequest：各族专用查询路由 + taskId 编码 + 尾斜杠裁剪", () => {
	const minimax = adapters.buildVideoQueryRequest("minimax-v2", { baseUrl: "https://gw.example.com/", apiKey: "sk", taskId: "t/1" });
	assert.equal(minimax.url, "https://gw.example.com/gateway/minimax/v2/query/video_generation/t%2F1");
	const ark = adapters.buildVideoQueryRequest("seedance-ark", { baseUrl: "https://gw.example.com", apiKey: "sk", taskId: "t1" });
	assert.equal(ark.url, "https://gw.example.com/gateway/ark/v3/generations/tasks/t1");
});

test("parseVideoSubmitResponse：task_id / taskId / id 三种键位", () => {
	for (const payload of [{ task_id: " a " }, { taskId: "b" }, { id: "c" }]) {
		const parsed = adapters.parseVideoSubmitResponse(payload);
		assert.equal(
			parsed.taskId,
			["a", "b", "c"].find((value) => value === parsed.taskId),
		);
	}
	assert.equal("taskId" in adapters.parseVideoSubmitResponse({ error: { message: "boom" } }), false);
});

test("parseVideoQueryResponse：minimax 网关包裹形态（task.status + task.content.url）", () => {
	const parsed = adapters.parseVideoQueryResponse({
		task: { status: "succeed", content: { url: "https://cdn.example.com/v.mp4" } },
	});
	assert.equal(parsed.kind, "ok");
	assert.equal(parsed.status, "succeeded");
	assert.equal(parsed.artifactUrl, "https://cdn.example.com/v.mp4");
});

test("parseVideoQueryResponse：ark 平铺形态（content.video_url）与原生 file.download_url", () => {
	const ark = adapters.parseVideoQueryResponse({ status: "queued", content: {} });
	assert.equal(ark.kind, "ok");
	assert.equal(ark.status, "queued");
	const native = adapters.parseVideoQueryResponse({ status: "succuess", file: { download_url: "https://x.example.com/n.mp4" } });
	assert.equal(native.status, "succeeded");
	assert.equal(native.artifactUrl, "https://x.example.com/n.mp4");
});

test("parseVideoQueryResponse：failed 不要求产物；succeeded 缺 URL 是错误；未知状态是错误", () => {
	const failed = adapters.parseVideoQueryResponse({ task: { status: "failed" } });
	assert.equal(failed.kind, "ok");
	assert.equal(failed.status, "failed");
	assert.equal(failed.artifactUrl, undefined);
	const noUrl = adapters.parseVideoQueryResponse({ status: "succeeded" });
	assert.equal(noUrl.kind, "error");
	const unknown = adapters.parseVideoQueryResponse({ status: "warping" });
	assert.equal(unknown.kind, "error");
});

test("extractVideoVendorError：error.message 优先，base_resp.status_msg 兜底，超长截断", () => {
	assert.equal(adapters.extractVideoVendorError({ error: { message: " quota exceeded " } }), "quota exceeded");
	assert.equal(adapters.extractVideoVendorError({ base_resp: { status_msg: "invalid api key" } }), "invalid api key");
	assert.equal(adapters.extractVideoVendorError({ error: "plain string" }), "plain string");
	assert.equal(adapters.extractVideoVendorError({ task: { status: "failed", error: { message: "content policy" } } }), "content policy");
	const long = adapters.extractVideoVendorError({ error: { message: "x".repeat(600) } });
	assert.equal(long.length, 400);
	assert.equal(adapters.extractVideoVendorError("not-an-object"), "");
});

test("videoHttpErrorKind：401/403 → invalidKey，404/405 → badBaseUrl，其余 http", () => {
	assert.equal(adapters.videoHttpErrorKind(401), "invalidKey");
	assert.equal(adapters.videoHttpErrorKind(403), "invalidKey");
	assert.equal(adapters.videoHttpErrorKind(404), "badBaseUrl");
	assert.equal(adapters.videoHttpErrorKind(500), "http");
});
