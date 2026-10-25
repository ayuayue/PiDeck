/**
 * 侧栏会话行状态点（#390）：关闭会话后，状态点连同它的占位一起消失。
 *
 * 现象（用户反馈）：会话运行时标题左侧有一个状态小点，关闭后小点没了，
 * 但「点亮的那格 + gap」还留着——最近会话行因此比没有运行过的会话多出一截左内边距。
 * 根因是活动页只判 `runtime && <span …>`：detached/closed 的 runtime 仍在
 * runtimeBySessionId 里（value 有、色点类 undefined），空 span 照样占位。
 *
 * 这里钉行为：没有色点语义的状态整格不渲染；有色点语义时颜色语义不变。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SidebarStatusDot } = loadTsCommonJs("src/renderer/src/components/sidebar/SidebarStatusDot.tsx");

const render = (status) => renderToStaticMarkup(createElement(SidebarStatusDot, { status }));

test("没有色点语义的状态整格不渲染（不留标题左侧占位）", () => {
	for (const status of [undefined, null, "", "detached", "closed", "unknown-status"]) {
		assert.equal(render(status), "", `status=${String(status)} 不应渲染任何节点`);
	}
});

test("有色点语义的状态仍渲染对应颜色（idle 蓝 / 运行黄 / 失败红）", () => {
	assert.match(render("idle"), /bg-info/);
	assert.match(render("starting"), /bg-warning/);
	assert.match(render("running"), /bg-warning/);
	assert.match(render("error"), /bg-danger/);
	// 占位宽度只由真正渲染出来的点占用
	assert.match(render("idle"), /size-1\.5/);
});
