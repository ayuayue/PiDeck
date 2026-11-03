import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 不依赖真实加密驱动：验证非文本目标被拒绝、写入失败保留原字节，
// 不把用户上报的加密版本错误当作已经证实的根因。
const { writeTextFileGuarded } = loadTsCommonJs("src/main/files/textFileWrite.ts");
const { FileSystemService } = loadTsCommonJs("src/main/fs/FileSystemService.ts");

async function withTempDir(run) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-file-write-"));
	try {
		return await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("新文件：正常落盘且不残留临时文件", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		await writeTextFileGuarded(target, "<template>hi</template>\n");
		assert.equal(readFileSync(target, "utf8"), "<template>hi</template>\n");
		assert.deepEqual(readdirSync(dir), ["App.vue"], "原子写的临时文件必须已 rename 掉");
	});
});

test("覆盖文本文件：内容替换、无临时残留、权限位保持", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "main.ts");
		writeFileSync(target, "old\n");
		if (process.platform !== "win32") chmodSync(target, 0o755);
		await writeTextFileGuarded(target, "new\n");
		assert.equal(readFileSync(target, "utf8"), "new\n");
		assert.deepEqual(readdirSync(dir), ["main.ts"]);
		if (process.platform !== "win32") {
			assert.equal(statSync(target).mode & 0o777, 0o755, "rename 不能把 0o755 换成临时文件的 0o600");
		}
	});
});

test("密文目标必须拒绝写入，且原字节一个不变（DLP 容器不可被明文覆盖）", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		const ciphertext = Buffer.alloc(64, 0xaa);
		writeFileSync(target, ciphertext);
		await assert.rejects(() => writeTextFileGuarded(target, "<template>拼一句明文</template>"), /FILE_WRITE_BLOCKED_ENCRYPTED:64/, "非文本目标必须抛结构化前缀（渲染层按它走 i18n 文案）");
		assert.equal(Buffer.compare(readFileSync(target), ciphertext), 0, "拒绝写入时盘上字节必须原样保留");
		assert.deepEqual(readdirSync(dir), ["App.vue"], "拒绝路径也不能留下临时文件");
	});
});

test("含 NUL 的二进制目标同样拒绝（不只是 0xAA 密文）", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "blob.bin");
		const binary = Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43, 0x00]);
		writeFileSync(target, binary);
		await assert.rejects(() => writeTextFileGuarded(target, "text"), /FILE_WRITE_BLOCKED_ENCRYPTED:6/);
		assert.equal(Buffer.compare(readFileSync(target), binary), 0);
	});
});

test("新建文件不得截断同名已存在的文件", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		writeFileSync(target, "keep me\n");
		const service = new FileSystemService();
		await assert.rejects(() => service.create(dir, "App.vue", "file"), /EEXIST/);
		assert.equal(readFileSync(target, "utf8"), "keep me\n", "create 必须失败而不是先截断再写");
	});
});

test("少量非法 UTF-8 字节也不能被有损解码后覆盖", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		const original = Buffer.concat([Buffer.from("<template>hello</template>\n"), Buffer.from([0xff])]);
		writeFileSync(target, original);
		await assert.rejects(writeTextFileGuarded(target, "new"), /FILE_WRITE_BLOCKED_ENCRYPTED:/);
		assert.deepEqual(readFileSync(target), original);
	});
});

for (const phase of ["inspect", "write", "chmod", "rename"]) {
	for (const code of ["EACCES", "EPERM", "EBUSY", "EIO"]) {
		test(`${phase} ${code}：拒绝保存且原文件不变，不回退截断写`, async () => {
			await withTempDir(async (dir) => {
				const target = join(dir, "App.vue");
				const original = "<template>keep this intact</template>\r\n";
				writeFileSync(target, original);
				const failure = Object.assign(new Error(`${phase} blocked`), { code });
				const { writeTextFileGuarded: write } = loadTsCommonJs("src/main/files/textFileWrite.ts", {
					stubs: {
						"node:fs/promises": {
							...fs,
							rename: async (...args) => {
								if (phase === "rename") throw failure;
								return fs.rename(...args);
							},
							open: async (path, ...args) => {
								const handle = await fs.open(path, ...args);
								return {
									stat: (...params) => handle.stat(...params),
									read: async (...params) => {
										if (phase === "inspect" && path === target) throw failure;
										return handle.read(...params);
									},
									writeFile: async (...params) => {
										if (phase === "write") {
											await handle.writeFile("partial", "utf8");
											throw failure;
										}
										return handle.writeFile(...params);
									},
									chmod: async (...params) => {
										if (phase === "chmod") throw failure;
										return handle.chmod(...params);
									},
									close: () => handle.close(),
								};
							},
						},
					},
				});
				await assert.rejects(write(target, "new content"), { message: `FILE_ACCESS_DENIED:${code}` });
				assert.equal(readFileSync(target, "utf8"), original);
				assert.deepEqual(readdirSync(dir), ["App.vue"]);
			});
		});
	}
}

test("分块检查完整内容：尾部非法字节拒绝、跨块 UTF-8 字符放行", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		const invalid = Buffer.concat([Buffer.alloc(300 * 1024, 0x61), Buffer.from([0xff])]);
		writeFileSync(target, invalid);
		await assert.rejects(writeTextFileGuarded(target, "replacement"), /FILE_WRITE_BLOCKED_ENCRYPTED:/);
		assert.deepEqual(readFileSync(target), invalid);
		writeFileSync(target, "x".repeat(256 * 1024 - 1) + "中\r\n");
		await writeTextFileGuarded(target, "valid replacement\r\n");
		assert.equal(readFileSync(target, "utf8"), "valid replacement\r\n");
	});
});

test("同一路径重叠保存按调用顺序替换，旧内容不能最后覆盖新内容", async () => {
	const target = join(tmpdir(), "pideck-concurrent.vue");
	const files = new Map([[target, Buffer.from("original")]]);
	let releaseFirst;
	let markEntered;
	const gate = new Promise((resolve) => {
		releaseFirst = resolve;
	});
	const entered = new Promise((resolve) => {
		markEntered = resolve;
	});
	let renames = 0;
	const { writeTextFileGuarded: write } = loadTsCommonJs("src/main/files/textFileWrite.ts", {
		stubs: {
			"node:fs/promises": {
				...fs,
				realpath: async (path) => path,
				stat: async (path) => ({ size: files.get(path).length, mode: 0o644 }),
				open: async (path, flags) => {
					let position = 0;
					if (flags === "wx") files.set(path, Buffer.alloc(0));
					return {
						read: async (buffer) => {
							const bytesRead = files.get(path).copy(buffer, 0, position);
							position += bytesRead;
							return { bytesRead };
						},
						writeFile: async (content) => {
							files.set(path, Buffer.from(content));
						},
						chmod: async () => {},
						close: async () => {},
					};
				},
				rename: async (from, to) => {
					if (++renames === 1) {
						markEntered();
						await gate;
					}
					files.set(to, files.get(from));
					files.delete(from);
				},
				rm: async (path) => {
					files.delete(path);
				},
			},
		},
	});
	const first = write(target, "first edit");
	await entered;
	let secondDone = false;
	const second = write(target, "latest edit").then(() => {
		secondDone = true;
	});
	try {
		await setImmediate();
		assert.equal(secondDone, false, "第二次保存不能绕过挂起的第一次替换");
	} finally {
		releaseFirst();
		await Promise.all([first, second]);
	}
	assert.equal(files.get(target).toString(), "latest edit");
});

test("队列中的一次替换失败不阻塞后续保存，也不留下临时文件", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		writeFileSync(target, "original");
		let attempts = 0;
		const { writeTextFileGuarded: write } = loadTsCommonJs("src/main/files/textFileWrite.ts", {
			stubs: {
				"node:fs/promises": {
					...fs,
					rename: async (...args) => {
						if (++attempts === 1) throw Object.assign(new Error("blocked"), { code: "EPERM" });
						return fs.rename(...args);
					},
				},
			},
		});
		const rejected = assert.rejects(write(target, "first edit"), { message: "FILE_ACCESS_DENIED:EPERM" });
		const next = write(target, "latest edit");
		await Promise.all([rejected, next]);
		assert.equal(readFileSync(target, "utf8"), "latest edit");
		assert.deepEqual(readdirSync(dir), ["App.vue"]);
	});
});

test("按 realpath 返回的真实目标替换，不替换传入的别名目录项", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "target.vue");
		const alias = join(dir, "App.vue");
		writeFileSync(target, "original");
		writeFileSync(alias, "alias entry");
		// 模拟链接解析，不依赖 Windows 创建 symlink 的管理员权限；实际替换仍用真实 fs。
		const { writeTextFileGuarded: write } = loadTsCommonJs("src/main/files/textFileWrite.ts", {
			stubs: { "node:fs/promises": { ...fs, realpath: (path) => fs.realpath(path === alias ? target : path) } },
		});
		await write(alias, "saved through alias");
		assert.equal(readFileSync(target, "utf8"), "saved through alias");
		assert.equal(readFileSync(alias, "utf8"), "alias entry");
		assert.deepEqual(readdirSync(dir).sort(), ["App.vue", "target.vue"]);
	});
});

test("保存 symlink 写入真实目标且保留链接目录项", async (t) => {
	await withTempDir(async (dir) => {
		const target = join(dir, "target.vue");
		const link = join(dir, "App.vue");
		writeFileSync(target, "original");
		try {
			symlinkSync(target, link, "file");
		} catch (error) {
			if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
			t.skip("当前 Windows 账户无创建文件 symlink 权限");
			return;
		}
		await writeTextFileGuarded(link, "saved through link");
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(readFileSync(target, "utf8"), "saved through link");
		assert.equal(readFileSync(link, "utf8"), "saved through link");
		assert.deepEqual(readdirSync(dir).sort(), ["App.vue", "target.vue"]);
	});
});

test("临时文件名碰撞：不跟随或覆盖既有临时路径，也不清理别人的文件", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "App.vue");
		const collision = join(dir, ".App.vue.pideck-guard-test.tmp");
		writeFileSync(target, "original");
		writeFileSync(collision, "another writer");
		const { writeTextFileGuarded: write } = loadTsCommonJs("src/main/files/textFileWrite.ts", { stubs: { "node:crypto": { randomUUID: () => "guard-test" } } });
		await assert.rejects(write(target, "replacement"), { code: "EEXIST" });
		assert.equal(readFileSync(target, "utf8"), "original");
		assert.equal(readFileSync(collision, "utf8"), "another writer");
	});
});
