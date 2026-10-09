import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const noop = () => {};
const hidden = () => null;
const passthrough = ({ children }) => children;
// 配置化后 ComposerArea 不再内置规则，按 SessionView 的实际契约传入规则快照。
const defaultRules = JSON.parse(readFileSync("resources/reply-actions.default.json", "utf8")).items;
// 52cd7a46c 后 triggers 是 AND 语义（全部命中才展示，降噪）：fixture 文本「修改已完成，可以提交这些改动。」
// 只命中「继续」（纯 onStop）与「提交」「提交并推送」（textMatch 含完成/可以提交）；
// 「再确认一下」「运行测试看看结果」的 patterns 不往 fixture 里出现，必须不展示——这是降噪契约。
const matchedActionTexts = ["继续", "提交", "提交并推送"];
const textMatchOnlyTexts = ["再确认一下", "运行测试看看结果"];

/** 渲染真实输入栏布局，只替换与位置无关的编辑器、进程桥和发送控制器。 */
function renderComposer(run, options = {}) {
	const portals = [];
	const target = options.target === undefined ? { dataset: { sessionId: "session-a" } } : options.target;
	const { ComposerArea } = loadTsCommonJs("src/renderer/src/components/session/ComposerArea.tsx", {
		stubs: {
			jotai: {
				useAtomValue: () => ({}),
				// ComposerArea 的加载链拉进了 atoms/dsh-atoms.ts（模块顶层 atom() 建原子），
				// stub 需给一个可调用形式，返回对象字面量即可（useAtomValue 已被拦截，不会真正读它）。
				atom: (initial) => ({ init: initial }),
			},
			"@/lib/utils": { cn: (...classes) => classes.filter(Boolean).join(" ") },
			// desktopApi 模块顶层会按环境初始化 browserApi（访问 window），vm 沙箱无 window；
			// 本测试只验证布局与投递位置，不真调桌面 API，把不同层级的相对 specifier 都拦下。
			"../../desktopApi": { desktopApi: {} },
			"../desktopApi": { desktopApi: {} },
			"./desktopApi": { desktopApi: {} },
			"react-dom": {
				createPortal: (children, container) => {
					portals.push({ children, container });
					return null;
				},
			},
			"../../hooks/useSessionComposerController": {
				useSessionComposerController: () => ({
					draft: "保留的草稿",
					attachments: [],
					pasteFiles: { files: [] },
					editor: {},
					suggestions: {},
					pickers: {},
					modals: {},
					voice: {},
					sendState: { status: "idle" },
					delivery: { canSendQuickMessage: true, sendQuickMessage: noop },
					...options.composer,
				}),
			},
			"./ComposerParts": { ComposerBottomBar: hidden, ImagePreviewModal: hidden, PromptSuggestions: hidden },
			"./composer": { TipTapComposer: () => createElement("textarea", { "data-testid": "composer-editor", defaultValue: "保留的草稿" }) },
			"../app/SessionReferenceModal": { SessionReferenceModal: hidden },
			// SessionContextMeter 依赖链拉进 MarkdownStream → streamdown（ESM-only，vm CJS 加载不了）；
			// 本测试只验证建议 chips 的位置与投递，圆环渲染不在关注面内。
			"./SessionContextMeter": { SessionContextMeter: hidden },
			"./ComposerPanels": { ComposerAttachmentBar: hidden, ComposerSendControls: hidden, SessionDeliveryNotice: hidden },
			"./ComposerPickerHost": { ComposerPickerHost: ({ children }) => children(null) },
			"./SecurityControl": { SecurityControl: hidden },
			"./QuickMessageMenu": { QuickMessageMenu: hidden },
			"../../atoms/composer-atoms": { modelPendingByIdAtom: {} },
			"./ComposerRuntimeIntegrations": { ComposerRuntimeIntegrations: ({ children }) => children({}) },
			"./SessionPaneServices": { useSessionPaneServices: () => ({ hiddenComposerFeatures: [] }) },
			"../../desktopApi": { desktopApi: {} },
			"../../rendererUtils": { COMPOSER_TEXT_MAX_HEIGHT: 320 },
			"./ComposerStatsLine": { ComposerStatsLine: hidden },
			"./ComposerWidgetLayout": { ComposerWidgetLayoutProvider: passthrough, useComposerWidgetLayoutValue: () => ({}) },
			"./VoiceTranscriptionControls": { VoiceTranscriptionControls: hidden },
			"../bridge/BridgeSlot": { BridgeGuiSlot: hidden, BridgeWidgetSlot: hidden },
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/button": { Button: ({ children, variant: _variant, size: _size, ...props }) => createElement("button", props, children) },
		},
	});
	const html = renderToStaticMarkup(
		createElement(ComposerArea, {
			sessionId: "session-a",
			replyActionMessages: run?.items.map((item) => item.message) ?? [],
			replyActionRules: options.rules ?? defaultRules,
			replyActionsTarget: target,
			replyActionsBlocked: options.blocked,
			widgets: createElement("section", { "data-testid": "session-todo-strip" }, "待办 4 完成"),
		}),
	);
	return { html, portals, target, actionsHtml: portals.map((portal) => renderToStaticMarkup(portal.children)).join("") };
}

const completedRun = {
	kind: "agent-run",
	id: "run-a",
	items: [{ kind: "message", message: { id: "answer-a", agentId: "agent-a", role: "assistant", text: "修改已完成，可以提交这些改动。", stopReason: "stop", timestamp: 2 } }],
	startedAt: 1,
	endedAt: 2,
	askWaitMs: 0,
	askPending: false,
};

test("快捷操作只投到本会话的消息末尾，不再位于输入栏或待办卡列", () => {
	const { html, portals, target, actionsHtml } = renderComposer(completedRun);
	assert.ok(!html.includes('data-testid="session-commit-suggestion-strip"'), "不能保留旧的输入栏建议条");
	assert.ok(!html.includes('data-testid="session-reply-action-strip"'));
	assert.equal(portals.length, 1);
	assert.equal(portals[0].container, target);
	for (const text of matchedActionTexts) assert.ok(actionsHtml.includes(text));
	for (const text of textMatchOnlyTexts) assert.ok(!actionsHtml.includes(`title="${text}"`), "textMatch 未命中的动作不得展示（52cd7a46c 降噪语义）");
	assert.ok(html.indexOf('data-testid="session-todo-strip"') < html.indexOf('data-testid="composer-editor"'));
});

test("没有最新回复时不显示建议，也不影响待办栏与输入框", () => {
	const { html, actionsHtml } = renderComposer(undefined);
	assert.equal(actionsHtml, "");
	assert.ok(html.includes('data-testid="session-todo-strip"'));
	assert.ok(html.includes('data-testid="composer-editor"'));
});

test("规则已清空时不回退到内置动作，自定义规则按原文直发", () => {
	assert.equal(renderComposer(completedRun, { rules: [] }).portals.length, 0);
	const sent = [];
	const { portals, actionsHtml } = renderComposer(completedRun, {
		rules: [{ text: "核对本次差异", triggers: [{ kind: "onStop" }] }],
		composer: { delivery: { canSendQuickMessage: true, sendQuickMessage: (text) => sent.push(text) } },
	});
	assert.equal(portals.length, 1);
	assert.equal(portals[0].children.props.children.length, 1);
	assert.ok(actionsHtml.includes("核对本次差异"));
	portals[0].children.props.children[0].props.onClick();
	assert.deepEqual(sent, ["核对本次差异"]);
});

test("流式、投递中、投递未知和生图模式不提供快捷动作", () => {
	for (const composer of [{ isBusy: true }, { isStarting: true }, { sendState: { status: "sending" } }, { sendState: { status: "unknown" } }, { mode: "imagegen" }, { backend: "imagegen" }]) {
		assert.equal(renderComposer(completedRun, { composer }).actionsHtml, "");
	}
});

test("会话切换时不能把新会话操作投到上一栏的末尾", () => {
	assert.equal(renderComposer(completedRun, { target: { dataset: { sessionId: "session-b" } } }).portals.length, 0);
	assert.equal(renderComposer(completedRun, { target: null }).portals.length, 0);
});

test("Ask、重启或历史加载阻塞时隐藏回复操作", () => {
	assert.equal(renderComposer(completedRun, { blocked: true }).portals.length, 0);
});

test("回复操作沿用直发通道，不能替换输入框草稿", () => {
	const sent = [];
	const { html, portals } = renderComposer(completedRun, { composer: { delivery: { canSendQuickMessage: true, sendQuickMessage: (text) => sent.push(text) } } });
	assert.equal(portals.length, 1);
	assert.equal(portals[0].children.props.children.length, matchedActionTexts.length);
	for (const button of portals[0].children.props.children) button.props.onClick();
	assert.deepEqual(sent, matchedActionTexts);
	assert.ok(html.includes("保留的草稿"));
});

test("发送不可用时所有回复操作都禁用", () => {
	const { portals } = renderComposer(completedRun, { composer: { delivery: { canSendQuickMessage: false, sendQuickMessage: noop } } });
	assert.equal(portals.length, 1);
	assert.equal(portals[0].children.props.children.length, matchedActionTexts.length);
	for (const button of portals[0].children.props.children) assert.equal(button.props.disabled, true);
});
