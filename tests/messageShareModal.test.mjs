import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const shareModal = readFileSync("src/renderer/src/components/session/MessageShareModal.tsx", "utf8");
const tree = readFileSync("src/renderer/src/components/session/MessageSelectionTree.tsx", "utf8");
const selection = readFileSync("src/renderer/src/utils/messageSelection.ts", "utf8");
const checkbox = readFileSync("src/renderer/src/components/ui-shadcn/checkbox.tsx", "utf8");

test("message sharing keeps the SurfaceComponents facade after presentation extraction", () => {
	assert.match(shareModal, /export function MultiSelectModal/);
	assert.match(surface, /from "\.\/MessageShareModal"/);
	assert.match(surface, /export \{ MultiSelectModal \}/);
	// 选择逻辑与树渲染已抽到共享模块：弹窗只保留外壳与复制动作
	assert.match(shareModal, /from "\.\/MessageSelectionTree"/);
	assert.doesNotMatch(shareModal, /function getSelectableMessageIds/);
	assert.doesNotMatch(surface, /function getSelectableMessageIds/);
});

test("message sharing uses a shared tree component and pure selection logic", () => {
	assert.match(tree, /export function MessageSelectionTree/);
	assert.match(selection, /export function getSelectableMessageIds/);
	assert.match(selection, /export function toggleRun/);
});

test("checkbox tri-state icon targets the group wrapper, not the icon itself", () => {
	// Tailwind v4 data-* variant 只匹配元素自身属性；data-state 在父级 Indicator 上，
	// 图标必须用 group-data-* 才能随半选态切换（回归：曾误用 data-[state=indeterminate] 导致半选仍显示对勾）
	assert.match(checkbox, /data-slot="checkbox-indicator"[^>]*\bgroup\b/);
	assert.match(checkbox, /CheckIcon[^>]*group-data-\[state=indeterminate\]:hidden/);
	assert.match(checkbox, /MinusIcon[^>]*group-data-\[state=indeterminate\]:block/);
	assert.doesNotMatch(checkbox, /CheckIcon[^>]*[^-]data-\[state=indeterminate\]/);
});
