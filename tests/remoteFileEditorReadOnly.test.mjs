/**
 * 远端文件编辑器的只读门禁（capabilities.files.write=false）。
 *
 * 契约：`RemoteFileEditor` 新增可选 `canWrite?: boolean`，缺省 true（既有调用方零行为变化）。
 * false 时：编辑器 readOnly、Save 禁用、Ctrl+S 只吞默认动作且不保存，并显示一行只读原因。
 *
 * 做法：server render 真实组件，把草稿 hook / CodeMirror / ui 原语 / i18n 替身为可观测桩，
 * 断言的是组件自己的门禁逻辑，不是桩的行为。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const h = React.createElement;

let draftState = null;
const editorProps = [];
const buttons = [];

function baseDraft(overrides = {}) {
	return { phase: "ready", content: "a\nb", savedContent: "a\nb", errorCode: undefined, stale: false, blocked: false, rejectedEdits: 0, ...overrides };
}

const passthrough = ({ children }) => h(React.Fragment, null, children);
const stubs = {
	react: React,
	"lucide-react": { Loader2: () => null, RefreshCw: () => null, Save: () => null },
	"../../hooks/useRemoteFileDraft": {
		useRemoteFileDraft: () => ({
			draft: draftState.draft,
			loadError: draftState.loadError,
			dirty: draftState.dirty,
			change: (value) => editorProps.push({ change: value }),
			save: () => editorProps.push({ save: true }),
			reload: () => editorProps.push({ reload: true }),
		}),
	},
	"../../utils/imageMime": { imageMimeForPath: () => undefined },
	"./RemoteImagePreview": { RemoteImagePreview: () => null },
	"../../i18n": { t: (key) => key },
	"../app/CodeMirrorEditor": {
		CodeMirrorEditor: (props) => {
			editorProps.push(props);
			return h("div", { "data-codemirror": "1" });
		},
	},
	"../ui-shadcn/button": {
		Button: (props) => {
			buttons.push(props);
			const { variant, size, ...rest } = props;
			return h("button", rest, props.children);
		},
	},
	"../ui-shadcn/dialog": {
		Dialog: passthrough,
		DialogContent: passthrough,
		DialogHeader: passthrough,
		DialogFooter: passthrough,
		DialogTitle: passthrough,
		DialogDescription: passthrough,
	},
};

const { RemoteFileEditor, remoteFileSaveShortcut, remoteFileEditorReadOnly } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteFileEditor.tsx", { stubs });

function render({ canWrite, draft = baseDraft(), dirty = false, loadError = null } = {}) {
	editorProps.length = 0;
	buttons.length = 0;
	draftState = { draft, loadError, dirty };
	const props = { services: { projectId: "project", capabilities: { files: { write: canWrite !== false } } }, path: "src/a.ts", ...(canWrite === undefined ? {} : { canWrite }) };
	const html = renderToStaticMarkup(h(RemoteFileEditor, props));
	return {
		html,
		// CodeMirror 已改懒加载，SSR 里只出 Suspense fallback 拿不到编辑器 props；
		// 门禁值改由组件导出的同一纯函数给出，断言仍是组件自己的判据（不是桩的行为）。
		readOnly: remoteFileEditorReadOnly(canWrite !== false, draft.phase),
		save: buttons.find((item) => item["aria-label"] === "remoteFile.save"),
	};
}

test("canWrite=false：脏草稿也不可保存、编辑器只读、并显示只读原因", () => {
	const view = render({ canWrite: false, draft: baseDraft({ content: "changed", savedContent: "a" }), dirty: true });
	assert.equal(view.save.disabled, true, "只读时 Save 必须禁用（不是等用户点了才拿稳定码）");
	assert.equal(view.readOnly, true, "只读能力位必须落到编辑器 readOnly");
	// 纯函数必须真的接到编辑器上，不能只在测试里成立。
	assert.match(readFileSync("src/renderer/src/components/workspace/RemoteFileEditor.tsx", "utf8"), /readOnly=\{remoteFileEditorReadOnly\(canWrite, draft\.phase\)\}/);
	assert.match(view.html, /data-testid="remote-file-read-only"/);
	assert.match(view.html, /remoteFile\.readOnlyReason/);
});

test("canWrite 缺省与显式 true 行为不变：脏草稿可保存、编辑器可写、无只读提示", () => {
	for (const canWrite of [undefined, true]) {
		const view = render({ canWrite, draft: baseDraft({ content: "changed", savedContent: "a" }), dirty: true });
		assert.equal(view.save.disabled, false, "可写且脏草稿时 Save 必须可用");
		assert.equal(view.readOnly, false, "可写时编辑器不得只读");
		assert.doesNotMatch(view.html, /remote-file-read-only/, "可写时不应出现只读原因");
	}
	// 原有禁用判据仍然生效：不脏、非 ready、被阻塞都不允许保存。
	assert.equal(render({ draft: baseDraft(), dirty: false }).save.disabled, true);
	assert.equal(render({ draft: baseDraft({ phase: "loading" }), dirty: true }).save.disabled, true);
	assert.equal(render({ draft: baseDraft({ blocked: true }), dirty: true }).save.disabled, true);
});

test("Ctrl/Cmd+S：只读只吞默认动作、绝不保存；可写时才走保存", () => {
	const key = (overrides = {}) => ({ ctrlKey: false, metaKey: false, key: "s", ...overrides });
	assert.equal(remoteFileSaveShortcut(key({ ctrlKey: true }), true), "save");
	assert.equal(remoteFileSaveShortcut(key({ metaKey: true }), true), "save");
	assert.equal(remoteFileSaveShortcut(key({ ctrlKey: true, key: "S" }), true), "save");
	assert.equal(remoteFileSaveShortcut(key({ ctrlKey: true }), false), "swallow");
	assert.equal(remoteFileSaveShortcut(key({ metaKey: true }), false), "swallow");
	assert.equal(remoteFileSaveShortcut(key(), true), "pass");
	assert.equal(remoteFileSaveShortcut(key({ ctrlKey: true, key: "k" }), true), "pass");
	// 组件必须走这条判据，而不是无条件 save()。
	const source = readFileSync("src/renderer/src/components/workspace/RemoteFileEditor.tsx", "utf8");
	assert.match(source, /remoteFileSaveShortcut\(event, canWrite\)/);
	// 保存只能在 action === "save" 之下发生：只读分支先吞掉默认动作再 return。
	assert.match(source, /if \(action === "save"\) void save\(\)/);
});

test("远端面板把已有的 canWrite 能力位传给编辑器（门禁只有一处真值）", () => {
	const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
	assert.match(panel, /const canWrite = services\.capabilities\.files\.write;/);
	assert.match(panel, /<RemoteFileEditor[^>]*canWrite=\{canWrite\}/);
});
