import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DSH_RUNNER_NODE_ENV, DSH_RUNNER_NODE_DIRNAME, dshRunnerNodeFileName, resolveDshRunnerNodeSidecar } = loadTsCommonJs("src/main/dsh/dshRunnerNodeSidecar.ts");

test("dshRunnerNodeFileName：win32 是 node.exe，其余是 node", () => {
	assert.equal(dshRunnerNodeFileName("win32"), "node.exe");
	assert.equal(dshRunnerNodeFileName("linux"), "node");
	assert.equal(dshRunnerNodeFileName("darwin"), "node");
});

test("resolveDshRunnerNodeSidecar：非 win32 一律不解析", () => {
	assert.equal(resolveDshRunnerNodeSidecar({ platform: "linux", appPath: "C:\\app", envPath: "C:\\node.exe" }), undefined);
});

test("resolveDshRunnerNodeSidecar：env 覆盖优先于用户配置 / extraResources 残留", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-sidecar-"));
	try {
		const envPath = join(root, "override-node.exe");
		const configured = join(root, "configured-node.exe");
		const packaged = join(root, "resources-pack", DSH_RUNNER_NODE_DIRNAME);
		const appResources = join(root, "app", "resources", DSH_RUNNER_NODE_DIRNAME);
		await mkdir(packaged, { recursive: true });
		await mkdir(appResources, { recursive: true });
		await writeFile(envPath, "env");
		await writeFile(configured, "cfg");
		await writeFile(join(packaged, "node.exe"), "pack");
		await writeFile(join(appResources, "node.exe"), "app");
		assert.equal(
			resolveDshRunnerNodeSidecar({
				platform: "win32",
				appPath: join(root, "app"),
				resourcesPath: join(root, "resources-pack"),
				envPath,
				configuredPath: configured,
			}),
			envPath,
		);
		assert.equal(
			resolveDshRunnerNodeSidecar({
				platform: "win32",
				appPath: join(root, "app"),
				resourcesPath: join(root, "resources-pack"),
				configuredPath: configured,
			}),
			configured,
		);
		const userData = join(root, "userData", DSH_RUNNER_NODE_DIRNAME);
		await mkdir(userData, { recursive: true });
		const userSidecar = join(userData, "node.exe");
		await writeFile(userSidecar, "userdata");
		assert.equal(
			resolveDshRunnerNodeSidecar({
				platform: "win32",
				appPath: join(root, "app"),
				resourcesPath: join(root, "resources-pack"),
				userDataPath: join(root, "userData"),
			}),
			userSidecar,
		);
		assert.equal(
			resolveDshRunnerNodeSidecar({
				platform: "win32",
				appPath: join(root, "app"),
				resourcesPath: join(root, "resources-pack"),
			}),
			join(packaged, "node.exe"),
		);
		assert.equal(
			resolveDshRunnerNodeSidecar({
				platform: "win32",
				appPath: join(root, "app"),
			}),
			join(appResources, "node.exe"),
		);
		assert.equal(
			resolveDshRunnerNodeSidecar({
				platform: "win32",
				appPath: join(root, "missing"),
				envPath: "   ",
			}),
			undefined,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("安装包不再随带 dsh-runner-node/node.exe", () => {
	assert.equal(DSH_RUNNER_NODE_ENV, "PIDECK_DSH_RUNNER_NODE");
	assert.equal(DSH_RUNNER_NODE_DIRNAME, "dsh-runner-node");
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const winResources = JSON.stringify(pkg.build?.win?.extraResources ?? []);
	const globalResources = JSON.stringify(pkg.build?.extraResources ?? []);
	assert.equal(winResources.includes("dsh-runner-node"), false, "win.extraResources 不得再打 86MB node.exe");
	assert.equal(globalResources.includes("dsh-runner-node"), false);
	assert.equal(pkg.scripts["prepare:dsh-runner-node"], undefined);
});
