import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionShareExportService } = loadTsCommonJs("src/main/sessions/SessionShareExportService.ts");
const { DEFAULT_SESSION_SHARE_OPTIONS } = loadTsCommonJs("src/shared/types/sessionExport.ts");
const options = { ...DEFAULT_SESSION_SHARE_OPTIONS };
const source = () => ({ backend: "pi", title: "Share", cwd: "/workspace/fake", messages: [{ id: "u", agentId: "a", role: "user", timestamp: 0, text: "public answer" }], truncated: false });
const copy = { footer: "PiDeck shared copy", partialNotice: "Partial", warning: "Rules may miss content" };

async function setup(t, overrides = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-share-520-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let now = 100;
	const service = new SessionShareExportService({ load: async () => source(), resolveExportDir: () => dir, home: () => "/home/fake", copy: () => copy, now: () => now, ...overrides });
	return {
		service,
		dir,
		advance: (ms) => {
			now += ms;
		},
	};
}

test("saving writes exactly the reviewed HTML even if the source changes, and never exports excluded payload", async (t) => {
	const live = source();
	const { service, dir } = await setup(t, { load: async () => live });
	const preview = await service.prepare(1, { sessionId: "s1", options });
	assert.equal(preview.ok, true);
	assert.deepEqual(await readdir(dir), [], "preview must not create an unsanitized intermediate file");
	live.messages[0].text = "token=FAKE_LATE_SECRET_520";
	const saved = await service.save(1, preview.value.previewId);
	assert.equal(saved.ok, true);
	const bytes = await readFile(saved.value.path, "utf8");
	assert.equal(bytes, preview.value.html);
	assert.ok(!bytes.includes("FAKE_LATE_SECRET_520"));
	assert.match(saved.value.path, /\.html$/);
	assert.equal((await service.save(1, preview.value.previewId)).ok, false, "saved token is single-use");
});

test("concurrent saves consume one reviewed token only once", async (t) => {
	const { service } = await setup(t);
	const preview = await service.prepare(1, { sessionId: "s1", options });
	const results = await Promise.all([service.save(1, preview.value.previewId), service.save(1, preview.value.previewId)]);
	assert.equal(results.filter((result) => result.ok).length, 1);
});

test("preview ownership, release, expiry and bounds cannot be bypassed with renderer IDs or paths", async (t) => {
	const { service, advance, dir } = await setup(t);
	let preview = await service.prepare(1, { sessionId: "s1", options });
	assert.equal((await service.save(2, preview.value.previewId)).ok, false);
	service.release(2, preview.value.previewId);
	assert.equal((await service.save(1, "../../bad.html")).ok, false);
	service.release(1, preview.value.previewId);
	assert.equal((await service.save(1, preview.value.previewId)).ok, false);
	preview = await service.prepare(1, { sessionId: "s1", options });
	advance(16 * 60_000);
	assert.equal((await service.save(1, preview.value.previewId)).ok, false);
	preview = await service.prepare(1, { sessionId: "s1", options });
	service.releaseOwner(1);
	assert.equal((await service.save(1, preview.value.previewId)).ok, false);
	assert.deepEqual(await readdir(dir), []);
});

test("failed reads and invalid options produce a failure, not an apparently safe empty export", async (t) => {
	let reads = 0;
	const { service } = await setup(t, {
		load: async () => {
			reads += 1;
			throw new Error("PRIVATE_PATH_520 token=FAKE_SECRET_520");
		},
	});
	for (const invalid of [null, {}, { ...options, excludeImages: "yes" }, { ...options, unexpected: true }]) {
		const response = await service.prepare(1, { sessionId: "s", options: invalid });
		assert.equal(response.ok, false);
	}
	assert.equal(reads, 0);
	const response = await service.prepare(1, { sessionId: "s", options });
	assert.equal(response.ok, false);
	assert.ok(!JSON.stringify(response).includes("PRIVATE_PATH_520"));
	assert.ok(!JSON.stringify(response).includes("FAKE_SECRET_520"));
});

test("a new preview evicts that owner's old artifact and over-budget output is rejected", async (t) => {
	const { service } = await setup(t);
	const first = await service.prepare(1, { sessionId: "s1", options });
	const second = await service.prepare(1, { sessionId: "s1", options: { ...options, excludeThinking: false } });
	assert.equal(second.ok, true);
	assert.equal((await service.save(1, first.value.previewId)).ok, false);
	const huge = source();
	huge.messages[0].text = "x".repeat(9 * 1024 * 1024);
	const bounded = await setup(t, { load: async () => huge });
	assert.equal((await bounded.service.prepare(1, { sessionId: "s1", options })).ok, false);
});
