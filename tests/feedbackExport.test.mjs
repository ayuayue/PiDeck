import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function exporterHarness() {
	const saves = [];
	const dialogs = [];
	const { LogBundleExporter } = loadTsCommonJs("src/main/health/LogBundleExporter.ts", {
		stubs: {
			electron: {
				app: { getPath: () => "C:/Users/test" },
				dialog: {
					showSaveDialog: async (options) => {
						dialogs.push(options);
						return {
							canceled: false,
							filePath: "C:/Users/test/PiDeck-diagnostics.zip",
						};
					},
				},
			},
			"node:fs/promises": {
				writeFile: async (path, bytes, encoding) => saves.push({ path, bytes, encoding }),
			},
		},
	});
	const exporter = new LogBundleExporter({
		appLogger: {
			listFiles: async () => [],
			info: async () => {},
		},
	});
	return { exporter, saves, dialogs };
}

for (const kind of ["report", "bundle"]) {
	test(`${kind}: an empty report returns a structured error without opening a picker`, async () => {
		const h = exporterHarness();
		const input = { markdown: "", reportJson: "{}" };
		let result;
		await assert.doesNotReject(async () => {
			result = kind === "report" ? await h.exporter.exportReport(input) : await h.exporter.exportBundle(input);
		});
		assert.deepEqual({ ...result }, { ok: false, canceled: false, error: "Report content is empty." });
		assert.equal(h.dialogs.length, 0);
		assert.equal(h.saves.length, 0);
	});
}

test("report: a generated report without a description still exports its full Markdown", async () => {
	const h = exporterHarness();
	const markdown = "# PiDeck Diagnostic Report\nproblem:_（empty）_\n\nEnvironment and checks";
	const result = await h.exporter.exportReport({ markdown, reportJson: "{}" });
	assert.equal(result.ok, true);
	assert.equal(result.canceled, false);
	assert.equal(result.path, "C:/Users/test/PiDeck-diagnostics.zip");
	assert.equal(h.saves.length, 1);
	assert.equal(h.saves[0].bytes, markdown);
	assert.equal(h.saves[0].encoding, "utf8");
});

test("bundle: the same generated report is the report.md member of the exported ZIP", async () => {
	const h = exporterHarness();
	const markdown = "# PiDeck Diagnostic Report\nproblem:_（empty）_\n\nEnvironment and checks";
	const result = await h.exporter.exportBundle({
		markdown,
		reportJson: '{"environment":{}}',
	});
	assert.equal(result.ok, true);
	assert.equal(h.saves.length, 1);
	const zip = h.saves[0].bytes;
	assert.equal(zip.readUInt32LE(0), 0x04034b50);
	const fileNameLength = zip.readUInt16LE(26);
	const extraLength = zip.readUInt16LE(28);
	assert.equal(zip.subarray(30, 30 + fileNameLength).toString("utf8"), "diagnostics/report.md");
	const compressedSize = zip.readUInt32LE(18);
	const dataStart = 30 + fileNameLength + extraLength;
	assert.equal(inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)).toString("utf8"), markdown);
});

function dialogHarness(feedback) {
	const host = quickMessageHookHost();
	const toasts = [];
	const jsx = (type, props) => ({ type, props: props ?? {} });
	const { FeedbackDialog } = loadTsCommonJs("src/renderer/src/features/feedback/FeedbackDialog.tsx", {
		stubs: {
			react: host.react,
			"react/jsx-runtime": { jsx, jsxs: jsx },
			"lucide-react": {},
			"../../i18n": { t: (key) => key },
			"../../lib/utils": {
				cn: (...parts) => parts.filter(Boolean).join(" "),
			},
			"../../components/ui-shadcn/button": { Button: "Button" },
			"../../components/ui-shadcn/badge": { Badge: "Badge" },
			"../../components/ui-shadcn/scroll-area": { ScrollArea: "ScrollArea" },
			"../../components/ui-shadcn/textarea": { Textarea: "Textarea" },
			"../../components/ui-shadcn/tabs": {
				Tabs: "Tabs",
				TabsList: "TabsList",
				TabsTrigger: "TabsTrigger",
				TabsContent: "TabsContent",
			},
			"../../components/ui-shadcn/dialog": Object.fromEntries(["Dialog", "DialogClose", "DialogContent", "DialogHeader", "DialogTitle"].map((name) => [name, name])),
			"../../components/ui-shadcn/section-heading": {
				SectionHeading: "SectionHeading",
			},
			"./issueUrl": {
				buildFeedbackIssueUrl: () => "https://example.invalid/feedback",
			},
			"./useFeedbackReport": { useFeedbackReport: () => ({ ...feedback }) },
		},
	});
	function nodes(root) {
		const found = [];
		function visit(node) {
			if (Array.isArray(node)) {
				for (const child of node) visit(child);
				return;
			}
			if (!node || typeof node !== "object") return;
			if (typeof node.type === "function" && node.type.name === "ShareCard") {
				visit(node.type(node.props));
				return;
			}
			found.push(node);
			visit(node.props?.children);
		}
		visit(root);
		return found;
	}
	function render() {
		const all = nodes(
			host.render(() =>
				FeedbackDialog({
					open: true,
					appInfo: {},
					onClose: () => {},
					onToast: (message) => toasts.push(message),
				}),
			),
		);
		return {
			all,
			exports: all.filter((node) => node.type === "Button" && [node.props?.children].flat(Infinity).some((child) => ["feedback.share.exportAction", "feedback.share.exportZipAction"].includes(child))),
		};
	}
	return { render, unmount: host.unmount, toasts };
}

function feedback(overrides = {}) {
	return {
		report: null,
		state: "idle",
		context: { description: "", steps: "" },
		setContext: () => {},
		format: "text",
		setFormat: () => {},
		text: "",
		markdownText: "",
		copiedFormat: null,
		promptText: "",
		loadingDeepLink: false,
		deeplinkCopied: false,
		exportInFlight: false,
		run: async () => {},
		clear: () => {},
		copyText: async () => true,
		copyPrompt: async () => true,
		copyMarkdown: async () => true,
		exportMarkdown: async () => ({ ok: true }),
		exportBundle: async () => ({ ok: true }),
		...overrides,
	};
}

test("dialog: diagnostic report is required before either export action is available", () => {
	const pending = dialogHarness(feedback());
	let view = pending.render();
	assert.equal(view.exports.length, 2);
	for (const button of view.exports) assert.equal(button.props.disabled, true);
	pending.unmount();

	const ready = dialogHarness(
		feedback({
			report: { generatedAt: 1, checks: [] },
			markdownText: "# PiDeck Diagnostic Report",
		}),
	);
	view = ready.render();
	for (const button of view.exports) assert.equal(button.props.disabled, false);
	ready.unmount();
});

test("dialog: an IPC rejection becomes a localized failure toast, not an unhandled rejection", async () => {
	const h = dialogHarness(
		feedback({
			report: { generatedAt: 1, checks: [] },
			markdownText: "# PiDeck Diagnostic Report",
			exportBundle: async () => {
				throw new Error("channel disconnected");
			},
		}),
	);
	const zip = h.render().exports[1];
	assert.ok(zip);
	zip.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(h.toasts, ["feedback.exportFailchannel disconnected"]);
	h.unmount();
});
