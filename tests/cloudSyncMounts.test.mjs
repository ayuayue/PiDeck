import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLOUD_SYNC_MOUNTS_FILE, createMountRegistry } from "../src/main/cloudSync/cloudSyncMounts.ts";

/** 每个用例独立临时目录：baseDir + 一个已存在的目标目录。 */
async function makeRegistry() {
	const dir = await mkdtemp(join(tmpdir(), "pideck-mounts-"));
	const target = join(dir, "project");
	await mkdir(target);
	return { dir, target, registry: createMountRegistry(dir) };
}

test("挂载/查询/解挂基本流程", async () => {
	const { dir, target, registry } = await makeRegistry();
	try {
		const mounted = await registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: target });
		assert.equal(mounted.remoteProjectId, "p1");
		assert.equal(mounted.localPath, target);
		assert.ok(mounted.mountedAt > 0);

		assert.equal(registry.list().length, 1);
		assert.equal(registry.get("p1")?.remoteProjectName, "pideck");
		assert.equal(registry.get("missing"), undefined);

		await registry.unmount("p1");
		assert.equal(registry.list().length, 0);
		assert.equal(registry.get("p1"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("挂载映射持久化：重建 registry 后数据仍在", async () => {
	const { dir, target, registry } = await makeRegistry();
	try {
		await registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: target });

		const reloaded = createMountRegistry(dir);
		assert.equal(reloaded.list().length, 1);
		assert.equal(reloaded.get("p1")?.remoteProjectName, "pideck");
		assert.equal(reloaded.get("p1")?.localPath, target);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("同一远程项目重复挂载被拒绝", async () => {
	const { dir, target, registry } = await makeRegistry();
	try {
		await registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: target });
		await assert.rejects(
			registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: target }),
			/already mounted/,
		);
		assert.equal(registry.list().length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("挂载目标不存在被拒绝", async () => {
	const { dir, registry } = await makeRegistry();
	try {
		await assert.rejects(
			registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: join(dir, "nope") }),
			/does not exist/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("挂载目标是文件（非目录）被拒绝", async () => {
	const { dir, registry } = await makeRegistry();
	try {
		await writeFile(join(dir, "file.txt"), "x");
		await assert.rejects(
			registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: join(dir, "file.txt") }),
			/not a directory/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("相对路径被拒绝", async () => {
	const { dir, registry } = await makeRegistry();
	try {
		await assert.rejects(
			registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: "relative/path" }),
			/absolute path/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("空字段被拒绝", async () => {
	const { dir, target, registry } = await makeRegistry();
	try {
		await assert.rejects(
			registry.mount({ remoteProjectId: "", remoteProjectName: "pideck", localPath: target }),
			/non-empty/,
		);
		await assert.rejects(
			registry.mount({ remoteProjectId: "p1", remoteProjectName: "  ", localPath: target }),
			/non-empty/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("不同远程项目挂到同一目录被拒绝", async () => {
	const { dir, target, registry } = await makeRegistry();
	try {
		await registry.mount({ remoteProjectId: "p1", remoteProjectName: "pideck", localPath: target });
		await assert.rejects(
			registry.mount({ remoteProjectId: "p2", remoteProjectName: "other", localPath: target }),
			/already in use/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("卸载未挂载的项目静默成功", async () => {
	const { dir, registry } = await makeRegistry();
	try {
		await registry.unmount("ghost"); // 不抛错
		assert.equal(registry.list().length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("挂载文件损坏时返回空列表", async () => {
	const { dir, registry } = await makeRegistry();
	try {
		await writeFile(join(dir, CLOUD_SYNC_MOUNTS_FILE), "not-json{{");
		const reloaded = createMountRegistry(dir);
		assert.equal(reloaded.list().length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
