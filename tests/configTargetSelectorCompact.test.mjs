/**
 * 配置目标选择器：只有「存在第二个可选目标」时才值得渲染下拉。
 *
 * 0 个远端目标（本机是唯一选项）→ 纯文本显示当前目标，不再给一个只有一项的下拉；
 * 有 SSH / WSL 目标 → 恢复下拉，本机与远端可互相切换。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiConfigTargetSelector } = loadTsCommonJs("src/renderer/src/config/PiConfigTargetSelector.tsx", { stubs: { react: React } });

const LOCAL = { kind: "local" };
const render = (hosts) => renderToStaticMarkup(React.createElement(PiConfigTargetSelector, { target: LOCAL, hosts, onChange: () => {} }));

test("没有远端目标时不渲染下拉，只显示当前目标与添加说明", () => {
	const html = render([]);
	assert.doesNotMatch(html, /data-testid="config-target-selector"/, "只有本机一项时下拉是噪音");
	assert.match(html, /data-testid="config-target-current"/);
	assert.match(html, /本机/);
	assert.match(html, /暂无已验证的 SSH 主机/, "收起下拉后仍要告诉用户怎么加主机");
});

test("有 SSH 主机时恢复下拉（本机 ↔ 主机可切换）", () => {
	const html = render([{ kind: "ssh", id: "h1", label: "dev-box", sshHost: "root@10.0.0.1" }]);
	assert.match(html, /data-testid="config-target-selector"/);
	assert.doesNotMatch(html, /data-testid="config-target-current"/);
	assert.doesNotMatch(html, /暂无已验证的 SSH 主机/);
});

test("只有 WSL 档案也算有可切换目标", () => {
	const html = render([{ kind: "wsl", id: "w1", label: "Ubuntu", distro: "Ubuntu", user: "me" }]);
	assert.match(html, /data-testid="config-target-selector"/);
});
