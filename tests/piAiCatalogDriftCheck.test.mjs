/**
 * 目录版本漂移体检脚本单测（scripts/check-pi-ai-catalog-drift.mjs）。
 *
 * 用户报的「更新失败但老提示有更新」根因之一：仓库预生成件跟着 devDependencies 走，
 * npm latest 跟着上游发布走，两条线长期不同步（发行分支 1.3.0 / npm 1.4.0）。
 * `--check` 只能发现「本地 node_modules 与仓库文件不一致」，发现不了这一点。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, decideDrift, fetchNpmLatestVersion, parseArtifactPackageVersion, parseDeclaredVersion } from "../scripts/check-pi-ai-catalog-drift.mjs";

test("漂移体检：manifest 来源版本与 package.json 锁定版本解析", () => {
	const manifestText = JSON.stringify({ schemaVersion: 2, source: { packageName: "@earendil-works/pi-ai", packageVersion: "1.3.0" } });
	assert.equal(parseArtifactPackageVersion(manifestText), "1.3.0");
	assert.equal(parseArtifactPackageVersion("{not json"), null);
	assert.equal(parseArtifactPackageVersion(JSON.stringify({ schemaVersion: 2 })), null);

	const packageJsonText = JSON.stringify({ devDependencies: { "@earendil-works/pi-ai": "1.4.0" } });
	assert.equal(parseDeclaredVersion(packageJsonText), "1.4.0");
	// 范围说明锁定没生效（构建守卫会拦），体检侧按「无精确版本」处理
	assert.equal(parseDeclaredVersion(JSON.stringify({ devDependencies: { "@earendil-works/pi-ai": "^1.4.0" } })), null);
});

test("漂移体检：语义版本比较（含预发布）", () => {
	assert.equal(compareVersions("1.4.0", "1.3.0"), 1);
	assert.equal(compareVersions("1.3.0", "1.4.0"), -1);
	assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
	assert.equal(compareVersions("1.4.0-beta.1", "1.4.0"), -1);
	assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
	assert.equal(compareVersions("1.4", "1.4.0"), 0);
});

test("漂移体检：仓库件落后 npm 最新 → artifact-behind（退出码 1）", () => {
	const verdict = decideDrift({ artifactVersion: "1.3.0", declaredVersion: "1.4.0", npmLatest: "1.4.0" });
	assert.equal(verdict.status, "artifact-behind");
	assert.equal(verdict.artifactVsNpm, -1);
	// 锁定版本与仓库产物也没对齐时同样报出来
	assert.equal(verdict.declaredVsArtifact, 1);
});

test("漂移体检：npm 落后于仓库件属正常（上游尚未发布）→ npm-behind（退出码 0）", () => {
	const verdict = decideDrift({ artifactVersion: "1.5.0", declaredVersion: "1.5.0", npmLatest: "1.4.0" });
	assert.equal(verdict.status, "ok");
});

test("漂移体检：无法判定（文件缺/npm 不可达）不当作漂移（退出码 2）", () => {
	assert.equal(decideDrift({ artifactVersion: null, declaredVersion: "1.4.0", npmLatest: "1.4.0" }).reason, "artifact-missing");
	assert.equal(decideDrift({ artifactVersion: "1.3.0", declaredVersion: "1.3.0", npmLatest: null }).reason, "npm-unreachable");
});

test("漂移体检：第一个镜像失败后换第二个镜像取版本", async () => {
	const seen = [];
	const fetchImpl = async (url) => {
		seen.push(url);
		if (url.includes("npmmirror")) return { ok: false, text: async () => "" };
		return { ok: true, text: async () => JSON.stringify({ version: "1.4.0" }) };
	};
	assert.equal(await fetchNpmLatestVersion({ fetchImpl }), "1.4.0");
	assert.equal(seen.length, 2, "国内镜像挂了要继续试官方 registry");
});

test("漂移体检：镜像全挂返回 null（体检失败，不能报成数据有误）", async () => {
	const fetchImpl = async () => {
		throw new Error("offline");
	};
	assert.equal(await fetchNpmLatestVersion({ fetchImpl }), null);
});
