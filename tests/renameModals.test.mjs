import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const component = (name) => Object.assign(() => null, { displayName: name });
const dialog = Object.fromEntries(["Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle"].map((name) => [name, component(name)]));
const Input = component("Input");
const Button = component("Button");
const { RenameModals } = loadTsCommonJs("src/renderer/src/components/RenameModals.tsx", {
	stubs: {
		react: { useRef: () => ({ current: null }) },
		"../i18n": { t: (key) => key },
		"./ui-shadcn/dialog": dialog,
		"./ui-shadcn/input": { Input },
		"./ui-shadcn/button": { Button },
	},
});

function all(node, type) {
	if (!node || typeof node !== "object") return [];
	if (Array.isArray(node)) return node.flatMap((child) => all(child, type));
	return [...(node.type === type ? [node] : []), ...all(node.props?.children, type)];
}

function renderRename(overrides = {}) {
	let submitted = 0;
	let closed = 0;
	const tree = RenameModals({
		rename: {
			kind: "project",
			value: "Project",
			saving: false,
			onValueChange() {},
			onSubmit() {
				submitted++;
			},
			onClose() {
				closed++;
			},
			...overrides,
		},
	});
	return { tree, submitted: () => submitted, closed: () => closed };
}

test("rename uses an accessible input and selects its value on opening", () => {
	const { tree } = renderRename();
	const input = all(tree, Input)[0];
	assert.equal(input.props["aria-label"], "app.renameProjectTitle");
	let selected = 0;
	input.props.ref.current = {
		select() {
			selected++;
		},
	};
	let prevented = false;
	all(tree, dialog.DialogContent)[0].props.onOpenAutoFocus({
		preventDefault() {
			prevented = true;
		},
	});
	assert.equal(prevented, true);
	assert.equal(selected, 1);
});

test("Enter on Cancel does not submit, while Enter in the input submits once", () => {
	const h = renderRename();
	const content = all(h.tree, dialog.DialogContent)[0];
	assert.equal(content.props.onKeyDown, undefined);
	const input = all(h.tree, Input)[0];
	let prevented = 0;
	input.props.onKeyDown({
		key: "Enter",
		nativeEvent: { isComposing: false },
		preventDefault() {
			prevented++;
		},
	});
	assert.equal(h.submitted(), 1);
	assert.equal(prevented, 1);
	all(h.tree, Button)[0].props.onClick();
	assert.equal(h.closed(), 1);
	assert.equal(h.submitted(), 1);
});

test("saving removes the misleading close action and exposes busy status", () => {
	const h = renderRename({ saving: true });
	const content = all(h.tree, dialog.DialogContent)[0];
	assert.equal(content.props.showCloseButton, false);
	assert.equal(content.props["aria-busy"], true);
	assert.ok(all(h.tree, Button).every((button) => button.props.disabled));
	all(h.tree, dialog.Dialog)[0].props.onOpenChange(false);
	assert.equal(h.closed(), 0);
});

test("IME Enter and blank names do not submit", () => {
	for (const overrides of [{ value: "   " }, { saving: true }, {}]) {
		const h = renderRename(overrides);
		all(h.tree, Input)[0].props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() {} });
		assert.equal(h.submitted(), 0);
	}
	for (const overrides of [{ value: "   " }, { saving: true }]) {
		const h = renderRename(overrides);
		assert.equal(all(h.tree, Button)[1].props.disabled, true);
		all(h.tree, Input)[0].props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
		assert.equal(h.submitted(), 0);
	}
});

test("file rename preserves no-change cancellation and only handles Enter in its input", () => {
	let closed = 0;
	let confirmed;
	const tree = RenameModals({
		fileRename: {
			path: "/project/file.ts",
			name: "file.ts",
			inputValue: "file.ts",
			onInputChange() {},
			onClose() {
				closed++;
			},
			onConfirm(...args) {
				confirmed = args;
			},
		},
	});
	assert.equal(all(tree, dialog.DialogContent)[0].props.onKeyDown, undefined);
	assert.equal(all(tree, Input)[0].props["aria-label"], "drawer.renameTitle");
	all(tree, Input)[0].props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
	assert.equal(closed, 1);
	assert.equal(confirmed, undefined);
});
