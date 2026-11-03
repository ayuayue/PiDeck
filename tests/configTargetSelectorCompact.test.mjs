/**
 * 配置目标选择器：只有「存在第二个可选目标」时才渲染整条目标栏。
 *
 * 0 个远端目标 + 当前在本机 → 整条不渲染（标签、当前值、「去加 SSH 主机」的提示都是噪音）；
 * 有 SSH / WSL 目标 → 下拉，本机与远端可互相切换；
 * 当前停在已消失的远端主机上 → 仍然渲染，否则用户回不到本机。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiConfigTargetSelector } = loadTsCommonJs("src/renderer/src/config/PiConfigTargetSelector.tsx", { stubs: { react: React } });
const { configTargetBarVisible } = loadTsCommonJs("src/renderer/src/config/piConfigTargetModel.ts", { stubs: { react: React } });

const LOCAL = { kind: "local" };
const SSH = { kind: "ssh", id: "h1", label: "dev-box", sshHost: "root@10.0.0.1" };
const WSL = { kind: "wsl", id: "w1", label: "Ubuntu", distro: "Ubuntu", user: "me" };
const render = (hosts, target = LOCAL) => renderToStaticMarkup(React.createElement(PiConfigTargetSelector, { target, hosts, onChange: () => {} }));

// Radix 的 SelectContent 只在展开后渲染，静态笔下的下拉项不在 HTML 里，
// 因此「下拉里恒有本机」用源码层级断言（无条件渲染的 local 项），其余看触发器。
const source = readFileSync("src/renderer/src/config/PiConfigTargetSelector.tsx", "utf8");

test("没有剩余可选目标且停在本机时整条不渲染", () => {
	const html = render([]);
	assert.equal(html, "", "没有可切换的目标时连「目标：本机」这一行都不该出现");
});

test("有 SSH 主机时渲染下拉（本机 ↔ 主机可切换）", () => {
	const html = render([SSH]);
	assert.match(html, /data-testid="config-target-bar"/);
	assert.match(html, /data-testid="config-target-selector"/);
	assert.match(html, /本机/, "触发器显示当前目标");
	assert.match(source, /<SelectItem value="local" data-testid="config-target-local">/, "本机项恒在，才有回来的路");
});

test("只有 WSL 档案也算有可切换目标（资源三页只传 WSL 档案）", () => {
	const html = render([WSL]);
	assert.match(html, /data-testid="config-target-selector"/);
	assert.match(html, /本机/);
});

test("当前目标指向已消失的远端主机时仍渲染，且能切回本机", () => {
	const html = render([], { kind: "ssh", hostId: "gone" });
	assert.match(html, /data-testid="config-target-selector"/, "已失效的远端目标必须还能打开下拉");
	assert.match(html, /未知主机/);
	assert.match(source, /<SelectItem value="local" data-testid="config-target-local">/);
});

test("configTargetBarVisible 是唯一的可见性判定", () => {
	assert.equal(configTargetBarVisible(LOCAL, []), false);
	assert.equal(configTargetBarVisible(LOCAL, [SSH]), true);
	assert.equal(configTargetBarVisible(LOCAL, [WSL]), true);
	assert.equal(configTargetBarVisible({ kind: "ssh", hostId: "gone" }, []), true);
	assert.equal(configTargetBarVisible({ kind: "wsl", hostId: "gone" }, []), true);
});
