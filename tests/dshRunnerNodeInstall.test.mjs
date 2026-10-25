import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DSH_RUNNER_NODE_SIDECAR_VERSION, dshRunnerNodeSidecarArch, dshRunnerNodeZipInnerDir, installDshRunnerNodeSidecar, resolveDshRunnerNodeIndexUrl, resolveDshRunnerNodeReleaseUrl } = loadTsCommonJs("src/main/dsh/dshRunnerNodeInstall.ts");
const { dshRunnerNodeUserDataSidecar } = loadTsCommonJs("src/main/dsh/dshRunnerNodeSidecar.ts");
const { DSH_RUNNER_NODE_INDEX_FILE, DSH_RUNNER_NODE_RELEASE_TAG, defaultDshRunnerNodeIndexUrl, dshRunnerNodeAssetDownloadUrl, dshRunnerNodeReleasePageUrl, dshRunnerNodeZipName, officialNodeZipUrl, selectDshRunnerNodeRelease } = loadTsCommonJs("src/shared/types/dshRunnerNodeRelease.ts");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function sampleIndex(over = {}) {
	return {
		schemaVersion: 1,
		releases: [
			{
				version: "24.13.0",
				arch: "x64",
				url: officialNodeZipUrl("24.13.0", "x64"),
				sha256: HASH_A,
				size: 12,
				...over,
			},
		],
	};
}

test("IPC / preload 三处同步注册一键下载通道", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(ipc, /dshInstallRunnerNode:\s*"dsh:install-runner-node"/);
	assert.match(systemIpc, /ipcChannels\.dshInstallRunnerNode/);
	assert.match(systemIpc, /fetchDshRunnerNodeIndex/);
	assert.match(preload, /installDshRunnerNode:\s*\(\)\s*=>/);
	assert.match(preload, /ipcChannels\.dshInstallRunnerNode/);
	const row = readFileSync("src/renderer/src/components/app/settings/DshRunnerNodeRow.tsx", "utf8");
	assert.match(row, /dshRunnerNodeReleasePageUrl/);
	assert.doesNotMatch(row, /releases\/tag\/dsh-runner-node/);
});

test("客户端下载走 latest 应用 Release，不直连 nodejs.org，也不单独建 sidecar tag", () => {
	assert.equal(DSH_RUNNER_NODE_SIDECAR_VERSION, "24.13.0");
	assert.equal(dshRunnerNodeSidecarArch("x64"), "x64");
	assert.equal(dshRunnerNodeSidecarArch("arm64"), "arm64");
	assert.equal(DSH_RUNNER_NODE_RELEASE_TAG, "latest");
	assert.equal(defaultDshRunnerNodeIndexUrl("atomgit"), "https://atomgit.com/ayuayue/PiDeck/releases/download/latest/dsh-runner-node-releases.json");
	assert.equal(defaultDshRunnerNodeIndexUrl("github"), "https://github.com/ayuayue/PiDeck/releases/latest/download/dsh-runner-node-releases.json");
	assert.equal(dshRunnerNodeAssetDownloadUrl("atomgit", "node-v24.13.0-win-x64.zip"), "https://atomgit.com/ayuayue/PiDeck/releases/download/latest/node-v24.13.0-win-x64.zip");
	assert.equal(dshRunnerNodeReleasePageUrl("github"), "https://github.com/ayuayue/PiDeck/releases/latest");
	assert.equal(dshRunnerNodeReleasePageUrl("atomgit"), "https://atomgit.com/ayuayue/PiDeck/releases/latest");
	assert.equal(resolveDshRunnerNodeIndexUrl({ updateSource: "github" }), defaultDshRunnerNodeIndexUrl("github"));
	assert.equal(resolveDshRunnerNodeReleaseUrl(sampleIndex().releases[0], "atomgit", "x64", "24.13.0"), dshRunnerNodeAssetDownloadUrl("atomgit", dshRunnerNodeZipName("24.13.0", "x64")));
	assert.match(officialNodeZipUrl("24.13.0", "x64"), /nodejs\.org/);
});

test("selectDshRunnerNodeRelease 必须匹配 arch + 版本 + 64 位哈希", () => {
	assert.equal(selectDshRunnerNodeRelease(sampleIndex().releases, "arm64", "24.13.0"), undefined);
	assert.equal(selectDshRunnerNodeRelease(sampleIndex({ sha256: "short" }).releases, "x64"), undefined);
	assert.equal(selectDshRunnerNodeRelease(sampleIndex().releases, "x64")?.arch, "x64");
});

test("非 Windows 拒绝安装，不写盘", async () => {
	const result = await installDshRunnerNodeSidecar({
		userDataPath: "C:\\pideck-should-not-write",
		platform: "linux",
		download: async () => {
			throw new Error("should not download");
		},
		fetchIndex: async () => sampleIndex(),
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /仅 Windows/);
});

test("已有兼容副本且未 force 时跳过下载", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-node-install-"));
	try {
		const dest = dshRunnerNodeUserDataSidecar(root, "win32");
		await mkdir(join(root, "dsh-runner-node"), { recursive: true });
		await writeFile(dest, "existing");
		let downloaded = false;
		const result = await installDshRunnerNodeSidecar({
			userDataPath: root,
			platform: "win32",
			probeVersion: async () => "24.13.0",
			download: async () => {
				downloaded = true;
			},
			fetchIndex: async () => sampleIndex(),
		});
		assert.equal(result.ok, true);
		assert.equal(result.path, dest);
		assert.equal(result.version, "24.13.0");
		assert.equal(downloaded, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("下载走索引条目并校验 sha256 后落到 userData", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-node-install-"));
	try {
		const dest = dshRunnerNodeUserDataSidecar(root, "win32");
		const zip = join(root, "local-node.zip");
		await writeFile(zip, "zip-bytes");
		const result = await installDshRunnerNodeSidecar({
			userDataPath: root,
			platform: "win32",
			arch: "x64",
			updateSource: "atomgit",
			fetchIndex: async () => sampleIndex({ url: pathToFileURL(zip).href, sha256: HASH_B }),
			download: async (url, zipPath) => {
				assert.equal(url, pathToFileURL(zip).href);
				await mkdir(join(zipPath, ".."), { recursive: true });
				await writeFile(zipPath, "zip-bytes");
			},
			sha256OfFile: async () => HASH_B,
			extract: async (_zip, destDir, innerRel) => {
				const extracted = join(destDir, innerRel);
				await mkdir(join(extracted, ".."), { recursive: true });
				await writeFile(extracted, "node-bin");
				return extracted;
			},
			probeVersion: async () => "24.13.0",
		});
		assert.equal(result.ok, true);
		assert.equal(result.path, dest);
		assert.equal(result.version, "24.13.0");
		assert.equal(await readFile(dest, "utf8"), "node-bin");
		assert.equal(existsSync(join(root, "dsh-runner-node", dshRunnerNodeZipInnerDir("24.13.0", "x64"))), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sha256 不匹配时拒绝落盘", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-node-install-"));
	try {
		const dest = dshRunnerNodeUserDataSidecar(root, "win32");
		const result = await installDshRunnerNodeSidecar({
			userDataPath: root,
			platform: "win32",
			arch: "x64",
			fetchIndex: async () => sampleIndex(),
			download: async (_url, zipPath) => {
				await mkdir(join(zipPath, ".."), { recursive: true });
				await writeFile(zipPath, "tampered");
			},
			sha256OfFile: async () => HASH_B,
			extract: async () => {
				throw new Error("should not extract");
			},
			probeVersion: async () => "24.13.0",
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /sha256/);
		assert.equal(existsSync(dest), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("打包脚本与安装包都不把 node.exe 打进 extraResources", () => {
	const pack = readFileSync("scripts/pack-dsh-runner-node.mjs", "utf8");
	assert.match(pack, /dsh-runner-node-releases\.json/);
	assert.match(pack, /nodejs\.org\/dist/);
	assert.match(pack, /latest 应用 Release/);
	assert.doesNotMatch(pack, /tag `dsh-runner-node`/);
	assert.equal(DSH_RUNNER_NODE_INDEX_FILE, "dsh-runner-node-releases.json");
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.scripts["runner-node:pack"], "node scripts/pack-dsh-runner-node.mjs");
	const extra = JSON.stringify(pkg.build?.extraResources ?? []);
	assert.equal(extra.includes("dsh-runner-node"), false);
	const publish = readFileSync(".github/workflows/publish-dsh-runner-node.yml", "utf8");
	assert.match(publish, /releases\/latest/);
	assert.doesNotMatch(publish, /TAG=dsh-runner-node/);
	const release = readFileSync(".github/workflows/release.yml", "utf8");
	assert.match(release, /dist-runtime\/dsh-runner-node\/\*\.zip/);
	assert.match(release, /Pack DSH runner Node sidecar/);
});
