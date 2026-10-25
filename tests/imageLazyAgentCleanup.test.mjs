import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 第二批内存优化契约：消息图片按需解码 + agentId 维度 atomFamily 随退出释放
const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const runtimeAtoms = readFileSync("src/renderer/src/atoms/runtime-atoms.ts", "utf8");
const bridge = readFileSync("src/renderer/src/hooks/useSessionRuntimeBridge.ts", "utf8");

test("message images decode lazily via IntersectionObserver", () => {
	// 两级内存策略：历史生图图片只带 ref（落盘 blob，走 pideck-img:// 协议由 Chromium
	// 流式加载，base64 根本不进消息对象——这是 246 MB OOM 事故的根本修复）；
	// 内联 base64 的图（正在生成/发送）仍受按需解码约束：解码位图是内存大头，
	// 视口外不设 src（不解码），进入视口（200px 提前量）才挂载；占位高度防滚动跳动。
	assert.match(surface, /function MessageImage\(/);
	assert.match(surface, /src=\{inView \? props\.src : undefined\}/);
	assert.match(surface, /rootMargin: \"200px\"/);
	assert.match(surface, /decoding=\"async\"/);
	assert.match(surface, /placeholderClass=\"min-h-24\"/);
	// 回归守卫：图片源必须经 imageContentSrc 解析。手写 data:${mimeType};base64,${data}
	// 会让 ref 形态的历史图渲染成 `base64,undefined`（不报错、只是白图，极难排查）。
	assert.match(surface, /import \{ imageContentSrc \} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/imageContentSrc";/);
	assert.doesNotMatch(surface, /src=\{`data:\$\{/);
	// 图片预览弹层不受影响（用户主动打开时必须即时显示，不套 IntersectionObserver）
	assert.match(surface, /const src = imageContentSrc\(props\.image\);/);
});

test("agentId atom families are released on agent exit", () => {
	// agentId 每次新 UUID：closed 后 family 缓存只增不清是慢泄漏，退出时统一释放
	assert.match(runtimeAtoms, /export const agentExitedAtom = atom\(null/);
	assert.match(runtimeAtoms, /agentByIdAtomFamily\.remove\(agentId\);/);
	assert.match(runtimeAtoms, /runtimeCapabilityByAgentIdAtomFamily\.remove\(agentId\);/);
	assert.match(runtimeAtoms, /sessionIdByRuntimeAgentIdAtomFamily\.remove\(agentId\);/);
	// 联动：agents:state 全量推送中检测 closed 触发
	assert.match(bridge, /event\.sourceChannel === \"agents:state\" && Array\.isArray\(event\.payload\)/);
	assert.match(bridge, /tab\.status === \"closed\"/);
	assert.match(bridge, /store\.set\(agentExitedAtom, tab\.id\);/);
});
