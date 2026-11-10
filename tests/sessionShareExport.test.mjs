import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionShareHtml } = loadTsCommonJs("src/main/sessions/sessionShareExport.ts");
const { DEFAULT_SESSION_SHARE_OPTIONS } = loadTsCommonJs("src/shared/types/sessionExport.ts");

const copy = { footer: "Shared from PiDeck", partialNotice: "Partial history", warning: "Automatic rules may miss sensitive content." };
const base = { agentId: "private-agent-id", timestamp: 1700000000000 };
const image = { type: "image", mimeType: "image/png", data: "RkFLRV9JTUFHRV9CWVRFUw==" };
function fixture() {
	return {
		backend: "pi",
		title: "token=FAKE_TITLE_CREDENTIAL_520",
		cwd: "D:\\private-workspace\\demo",
		messages: [
			{ ...base, id: "user", role: "user", text: "Public question D:\\private-workspace\\demo\\a.ts", images: [image], meta: { hidden: "HIDDEN_META_520" } },
			{ ...base, id: "assistant", role: "assistant", text: "Public answer", thinking: "PRIVATE_THINKING_520", meta: { trace: "PRIVATE_TRACE_520" } },
			{ ...base, id: "tool", role: "tool", text: "read: PRIVATE_RESULT_520", images: [image], meta: { toolName: "read", args: { path: "PRIVATE_ARG_520" }, fullText: "PRIVATE_RESULT_520", detailText: "PRIVATE_DETAIL_520", view: { secret: "PRIVATE_VIEW_520" } } },
			{ ...base, id: "system", role: "system", text: "PRIVATE_SYSTEM_MESSAGE_520" },
		],
		truncated: false,
	};
}

function build(source, options = DEFAULT_SESSION_SHARE_OPTIONS) {
	return buildSessionShareHtml(source, options, { home: "C:\\Users\\fake-user", exportedAt: 1700000000000, copy });
}

test("default share removes excluded fields from final HTML, not only the visible cards", () => {
	const source = fixture();
	const before = JSON.stringify(source);
	const result = build(source);
	for (const marker of ["PRIVATE_THINKING_520", "PRIVATE_ARG_520", "PRIVATE_RESULT_520", "PRIVATE_DETAIL_520", "PRIVATE_VIEW_520", "PRIVATE_TRACE_520", "PRIVATE_SYSTEM_MESSAGE_520", "HIDDEN_META_520", image.data, "private-agent-id", "FAKE_TITLE_CREDENTIAL_520", "private-workspace"]) {
		assert.ok(!result.html.includes(marker), `final bytes must not contain ${marker}`);
	}
	assert.ok(result.html.includes("Public answer"));
	assert.ok(result.html.includes("Public question"));
	assert.ok(result.html.includes("[workspace]"));
	assert.ok(result.html.includes(copy.warning));
	assert.equal(JSON.stringify(source), before, "source session is immutable");
	assert.equal(result.inventory.thinking, 1);
	assert.equal(result.inventory.toolArguments, 1);
	assert.equal(result.inventory.toolResults, 1);
	assert.equal(result.inventory.images, 2);
	assert.equal(result.inventory.systemMessages, 1);
	assert.ok(result.redactedFields > 0);
});

test("DSH uses the same share whitelist without retaining fullText/detail/view payload copies", () => {
	const source = fixture();
	source.backend = "dsh";
	const html = build(source).html;
	for (const marker of ["PRIVATE_THINKING_520", "PRIVATE_ARG_520", "PRIVATE_RESULT_520", "PRIVATE_DETAIL_520", image.data]) assert.ok(!html.includes(marker), marker);
	assert.ok(html.includes("Public answer"));
});

test("explicit inclusion preserves only allowed fields and independently controls tool arguments and results", () => {
	const source = fixture();
	const options = { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeThinking: false, excludeToolArguments: false, excludeToolResults: false, excludeImages: false, excludeSystemMessages: false, excludeWorkspace: false, redactSecrets: false, redactPaths: false };
	const all = build(source, options).html;
	for (const marker of ["PRIVATE_THINKING_520", "PRIVATE_ARG_520", "PRIVATE_RESULT_520", "PRIVATE_SYSTEM_MESSAGE_520", image.data]) assert.ok(all.includes(marker), marker);
	for (const marker of ["PRIVATE_DETAIL_520", "PRIVATE_VIEW_520", "PRIVATE_TRACE_520", "HIDDEN_META_520", "private-agent-id"]) assert.ok(!all.includes(marker), marker);
	const argsOnly = build(source, { ...options, excludeToolResults: true }).html;
	assert.ok(argsOnly.includes("PRIVATE_ARG_520"));
	assert.ok(!argsOnly.includes("PRIVATE_RESULT_520"));
	const resultsOnly = build(source, { ...options, excludeToolArguments: true }).html;
	assert.ok(!resultsOnly.includes("PRIVATE_ARG_520"));
	assert.ok(resultsOnly.includes("PRIVATE_RESULT_520"));
});

test("redaction covers titles, thinking, structured arguments, results, URL tokens and escaped path variants", () => {
	const source = fixture();
	source.messages = [
		{ ...base, id: "a", role: "assistant", text: "https://example.invalid/?token=FAKE_QUERY_520&ok=1 C:\\Users\\fake-user\\doc.txt", thinking: "Bearer FAKE_BEARER_520" },
		{ ...base, id: "t", role: "tool", text: "read: not authoritative", meta: { toolName: "read", args: { password: "FAKE_PASSWORD_520", file: "D:\\private-workspace\\demo\\file.ts" }, fullText: "token=FAKE_TOOL_TOKEN_520 D:/private-workspace/demo/out.txt" } },
	];
	const html = build(source, { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeThinking: false, excludeToolArguments: false, excludeToolResults: false }).html;
	for (const marker of ["FAKE_QUERY_520", "FAKE_BEARER_520", "FAKE_PASSWORD_520", "FAKE_TOOL_TOKEN_520", "fake-user", "private-workspace"]) assert.ok(!html.includes(marker), marker);
	assert.ok(html.includes("[redacted]"));
	assert.ok(html.includes("[workspace]"));
});

test("Pi share projection separates thinking from text and preserves literal thinking tags written as answer text", () => {
	const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
	const raw = [
		{
			role: "assistant",
			timestamp: 0,
			content: [
				{ type: "thinking", thinking: "PRIVATE_PI_THINKING_520" },
				{ type: "text", text: "public answer <thinking>literal example</thinking>" },
			],
		},
	];
	const normal = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
	assert.ok(normal.convert("_viewer", raw)[0].text.includes("PRIVATE_PI_THINKING_520"), "UI compatibility: existing projection is unchanged");
	const share = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false, purpose: "share" });
	const source = fixture();
	source.messages = share.convert("_share", raw);
	const html = build(source).html;
	assert.ok(!html.includes("PRIVATE_PI_THINKING_520"));
	assert.ok(html.includes("public answer"));
	assert.ok(html.includes("literal example"), "real answer text is not stripped by a markup regex");
});

test("excluded images are removed from inline Markdown, HTML and data-URL payloads too", () => {
	const source = fixture();
	source.messages = [{ ...base, id: "u", role: "user", text: `before ![PRIVATE_ALT_520](data:image/png;base64,${image.data}) <img src="PRIVATE_IMAGE_URL_520"> after` }];
	const html = build(source).html;
	for (const marker of [image.data, "PRIVATE_ALT_520", "PRIVATE_IMAGE_URL_520", "data:image/png"]) assert.ok(!html.includes(marker), marker);
	assert.ok(html.includes("before"));
	assert.ok(html.includes("after"));
});

test("known home and workspace prefixes are redacted inside JSON-escaped tool arguments", () => {
	const source = fixture();
	source.messages = [{ ...base, id: "t", role: "tool", text: "read", meta: { toolName: "read", args: { file: "C:\\Users\\fake-user\\a.ts", cwd: "D:\\private-workspace\\demo\\a.ts" } } }];
	const html = build(source, { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeToolArguments: false }).html;
	assert.ok(!html.includes("fake-user"));
	assert.ok(!html.includes("private-workspace"));
});

test("empty retained content stays empty, unsafe image refs are not copied, partial exports are identified", () => {
	const source = fixture();
	source.truncated = true;
	source.messages = [
		{
			...base,
			id: "a",
			role: "assistant",
			text: "",
			thinking: "PRIVATE_THINKING_520",
			images: [
				{ type: "image", mimeType: "image/svg+xml", data: "UNSUPPORTED_IMAGE_520" },
				{ type: "image", mimeType: "image/png", ref: "PRIVATE_BLOB_REF_520" },
			],
		},
	];
	const result = build(source, { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeImages: false });
	assert.ok(!result.html.includes("PRIVATE_THINKING_520"));
	assert.ok(!result.html.includes("UNSUPPORTED_IMAGE_520"));
	assert.ok(!result.html.includes("PRIVATE_BLOB_REF_520"));
	assert.ok(result.html.includes(copy.partialNotice));
	assert.ok(!result.html.includes("<script"));
	assert.ok(!result.html.includes("application/json"));
});
