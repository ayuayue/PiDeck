/**
 * versionCompare 单测：compareVersions / normalizeVersion 的完整 semver 预发布语义。
 *
 * 覆盖：
 * - 预发布低于同号正式版（0.8.0-beta.9 < 0.8.0）：旧实现把预发布数字段当版本段逐段比，误判为更高，
 *   导致「切换到开发版」对话框在正式版已高于开发版最新版时仍提供旧开发版下载。
 * - 预发布标识为纯数字时按数值比较（beta.9 < beta.10，而非字典序）。
 * - 核心数字段优先于预发布（0.9.0 > 0.8.0-beta.9）。
 * - 全等判定（0.8.0 == 0.8.0、同号同标识全等）。
 * - 含字母标识高于纯数字标识（1.0.0-1 < 1.0.0-alpha）并按字典序比较（alpha < beta）。
 * - 前缀相同时标识少者低（1.0.0-alpha < 1.0.0-alpha.1）。
 * - v 前缀归一（normalizeVersion）与 build 元数据不参与比较。
 *
 * 生产模块经 tests/helpers/loadTsCommonJs.mjs 加载（完整依赖图 vm helper，禁止手写 vm 加载器）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { compareVersions, normalizeVersion } = loadTsCommonJs("src/main/utils/versionCompare.ts");

test("预发布低于同号正式版：0.8.0-beta.9 < 0.8.0（旧实现误判更高的缺陷回归）", () => {
	assert.ok(compareVersions("0.8.0-beta.9", "0.8.0") < 0);
	assert.ok(compareVersions("0.8.0", "0.8.0-beta.9") > 0);
});

test("预发布标识为纯数字时按数值比较：beta.9 < beta.10", () => {
	assert.ok(compareVersions("0.8.0-beta.9", "0.8.0-beta.10") < 0);
	assert.ok(compareVersions("0.8.0-beta.10", "0.8.0-beta.9") > 0);
});

test("核心数字段优先于预发布：0.9.0 > 0.8.0-beta.9", () => {
	assert.ok(compareVersions("0.9.0", "0.8.0-beta.9") > 0);
});

test("单段预发布标识同样低于正式版：0.7.2 > 0.7.2-beta", () => {
	assert.ok(compareVersions("0.7.2", "0.7.2-beta") > 0);
	assert.ok(compareVersions("0.7.2-beta", "0.7.2") < 0);
});

test("全等：0.8.0 == 0.8.0；同号同标识全等：0.8.0-beta.9 == 0.8.0-beta.9", () => {
	assert.equal(compareVersions("0.8.0", "0.8.0"), 0);
	assert.equal(compareVersions("0.8.0-beta.9", "0.8.0-beta.9"), 0);
});

test("含字母标识高于纯数字并按字典序：1.0.0-1 < 1.0.0-alpha < 1.0.0-beta", () => {
	assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0);
	assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0);
	assert.ok(compareVersions("1.0.0-alpha", "1.0.0-1") > 0);
});

test("前缀相同时标识少者低：1.0.0-alpha < 1.0.0-alpha.1", () => {
	assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
});

test("normalizeVersion 去除 v 前缀；build 元数据不参与比较", () => {
	assert.equal(normalizeVersion("v0.8.0"), "0.8.0");
	assert.equal(compareVersions("0.8.0+build.5", "0.8.0"), 0);
});
