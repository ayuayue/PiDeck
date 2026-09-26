// tests/channelIdentity.test.mjs
// 编译期通道判定：__PIDECK_DEV_BUILD__ 真值直接映射 dev/stable 通道。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

test("__PIDECK_DEV_BUILD__=true 时通道为 dev", () => {
	const load = createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: true } });
	const mod = load("src/main/update/channelIdentity.ts");
	assert.equal(mod.resolveUpdateChannel(), "dev");
});

test("__PIDECK_DEV_BUILD__=false 时通道为 stable", () => {
	const load = createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: false } });
	const mod = load("src/main/update/channelIdentity.ts");
	assert.equal(mod.resolveUpdateChannel(), "stable");
});
