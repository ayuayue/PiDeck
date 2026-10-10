import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const header = readFileSync("src/renderer/src/components/session/turn/TurnAuthorHeader.tsx", "utf8");
const backendMark = readFileSync("src/renderer/src/components/session/SessionSourceBadge.tsx", "utf8");

test("TurnRow always mounts a Pi/DSH author header, not DSH-only text", () => {
	assert.match(turnRow, /<TurnAuthorHeader backend=\{props\.backend\} endedAt=\{run\.endedAt\} \/>/);
	// 旧策略：Pi 默认不署名、只给 DSH 短标签。时间线行头已改回两边都用 logo。
	assert.doesNotMatch(turnRow, /props\.backend === "dsh" &&/);
	assert.doesNotMatch(turnRow, /sessionBackend\.dsh/);
});

test("TurnAuthorHeader uses shadcn Avatar logos without a visible name", () => {
	assert.match(header, /from "\.\.\/\.\.\/ui-shadcn\/avatar"/);
	assert.match(header, /<Avatar title=\{name\}/);
	assert.match(header, /<AvatarFallback/);
	assert.match(header, /<PiLogo/);
	assert.match(header, /<DshLogo/);
	assert.match(header, /data-turn-author=\{backend\}/);
	// 缺省按 pi 处理，兼容旧调用方不传 backend
	assert.match(header, /props\.backend \?\? "pi"/);
	// 名称只给读屏/悬停，不再跟在 logo 旁边当可见署名
	assert.match(header, /aria-label=\{name\}/);
	assert.match(header, /sessionBackend\.pi/);
	assert.match(header, /sessionBackend\.dsh/);
	// ACP 回复头不能冒充 pi：终端图标 + Agent CLI 名称（工具名在输入框/详情展示）
	assert.match(header, /isAcp \? <TerminalIcon/);
	assert.match(header, /sessionBackend\.acp/);
	assert.doesNotMatch(header, /<span[^>]*>\{\s*name\s*\}<\/span>/);
});

test("sidebar SessionBackendMark still hides Pi to avoid list noise", () => {
	// 侧栏/Tab 降噪策略保持不变：只有非默认后端（dsh/imagegen/acp）才打标（acp 用终端图标+Agent CLI）。
	assert.match(backendMark, /if \(props\.backend === "dsh" \|\| props\.backend === "imagegen" \|\| props\.backend === "acp"\)/);
	assert.match(backendMark, /<SessionBackendBadge backend=\{props\.backend\}/);
	assert.match(backendMark, /return null;/);
});
