import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
	for (let index = 0; index < 6; index += 1) await flush();
};

function capabilities(overrides = {}) {
	return { read: true, write: true, upload: true, download: true, ...overrides };
}

function makeServices(overrides = {}) {
	const uploads = [];
	const downloads = [];
	const files = {
		uploadFiles(target, source, options) {
			const call = { target, source, options };
			call.promise = new Promise((resolve, reject) => {
				call.resolve = resolve;
				call.reject = reject;
			});
			uploads.push(call);
			options?.onStarted?.({ operation: "upload", total: 100 });
			return call.promise;
		},
		downloadFile(target, options) {
			const call = { target, options };
			call.promise = new Promise((resolve, reject) => {
				call.resolve = resolve;
				call.reject = reject;
			});
			downloads.push(call);
			options?.onStarted?.({ operation: "download", total: 8 });
			return call.promise;
		},
	};
	return {
		projectId: overrides.projectId ?? "p1",
		generation: overrides.generation ?? "g1",
		capabilities: { files: overrides.capabilities ?? capabilities() },
		files,
		uploads,
		downloads,
	};
}

function harness(options = {}) {
	const host = quickMessageHookHost();
	const desktopApi = { files: { getPathForFile: () => "C:/tmp/a.txt" } };
	const { useRemoteProjectTransfer } = loadTsCommonJs("src/renderer/src/hooks/useRemoteProjectTransfer.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi },
			"../i18n": { t: (key, params) => (params === undefined ? key : key + JSON.stringify(params)) },
		},
	});
	const errors = [];
	const reloads = [];
	let services = options.services ?? makeServices();
	let state;
	const reload = async () => {
		reloads.push(1);
	};
	const render = (next = services) => {
		services = next;
		state = host.render(() => useRemoteProjectTransfer({ services, directory: "src", reload, setError: (message) => errors.push(message), searching: false }));
		return state;
	};
	return { host, render, view: () => state, errors, reloads, currentServices: () => services };
}

test("上传进度进入状态卡，取消只 abort 当前任务并收口为 cancelled", async () => {
	const h = harness();
	h.render();
	h.view().uploadFiles();
	assert.equal(h.currentServices().uploads.length, 1);
	const upload = h.currentServices().uploads[0];
	upload.options.onProgress({ operation: "upload", transferred: 40, total: 100 });
	h.render();
	assert.equal(h.view().transfers[0].operation, "upload");
	assert.equal(h.view().transfers[0].phase, "running");
	assert.equal(h.view().transfers[0].transferred, 40);
	assert.equal(h.view().transfers[0].total, 100);
	h.view().cancelTransfer(0);
	assert.equal(upload.options.signal.aborted, true);
	h.render();
	assert.equal(h.view().transfers[0].phase, "cancelling");
	upload.resolve({ ok: true, value: { canceled: true } });
	await settle();
	h.render();
	assert.equal(h.view().transfers[0].phase, "cancelled");
	assert.equal(h.reloads.length, 0);
	assert.equal(h.errors.length, 0);
	h.host.unmount();
});

test("下载进度同样可取消，terminal unknown 只展示 unknown", async () => {
	const h = harness();
	h.render();
	h.view().downloadFile("src/a.bin");
	const download = h.currentServices().downloads[0];
	download.options.onProgress({ operation: "download", transferred: 3, total: 8 });
	h.render();
	assert.equal(h.view().transfers[0].operation, "download");
	assert.equal(h.view().transfers[0].phase, "running");
	assert.equal(h.view().transfers[0].transferred, 3);
	assert.equal(h.view().transfers[0].total, 8);
	h.view().cancelTransfer(0);
	assert.equal(download.options.signal.aborted, true);
	download.resolve({ ok: false, code: "REMOTE_DOWNLOAD_RESULT_UNCONFIRMED", outcome: "unknown" });
	await settle();
	h.render();
	assert.equal(h.view().transfers[0].phase, "unknown");
	assert.equal(h.view().transfers[0].code, "REMOTE_DOWNLOAD_RESULT_UNCONFIRMED");
	assert.match(h.errors.at(-1), /^project\.remote\.transferUnknown/);
	h.host.unmount();
});

test("取消指定 UI 任务不会影响另一个并行 job", () => {
	const h = harness();
	h.render();
	h.view().uploadFiles();
	h.view().uploadFiles();
	const [first, second] = h.currentServices().uploads;
	h.view().cancelTransfer(0);
	assert.equal(first.options.signal.aborted, true);
	assert.equal(second.options.signal.aborted, false);
	h.host.unmount();
});

test("项目换代后旧任务的 late progress/success 不写新面板、不刷新、不报错", async () => {
	const h = harness();
	const firstServices = h.currentServices();
	h.render();
	h.view().uploadFiles();
	const oldUpload = firstServices.uploads[0];
	const nextServices = makeServices({ projectId: "p2", generation: "g2" });
	h.render(nextServices);
	h.render(nextServices);
	assert.equal(oldUpload.options.signal.aborted, true, "换代必须 abort 旧项目任务");
	oldUpload.options.onProgress({ operation: "upload", transferred: 75, total: 100 });
	oldUpload.resolve({ ok: true, value: { uploaded: [{ name: "a.bin", bytes: 75 }], failed: [] } });
	await settle();
	h.render(nextServices);
	assert.equal(h.view().transfers.length, 0);
	assert.equal(h.errors.length, 0);
	assert.equal(h.reloads.length, 0);
	h.host.unmount();
});

test("项目换代后旧任务失败也不能污染新代错误与结果", async () => {
	const h = harness();
	const firstServices = h.currentServices();
	h.render();
	h.view().downloadFile("src/a.bin");
	const oldDownload = firstServices.downloads[0];
	const nextServices = makeServices({ projectId: "p2", generation: "g2" });
	h.render(nextServices);
	h.render(nextServices);
	oldDownload.resolve({ ok: false, code: "REMOTE_DOWNLOAD_FAILED", outcome: "rejected" });
	await settle();
	h.render(nextServices);
	assert.equal(h.view().transfers.length, 0);
	assert.equal(h.errors.length, 0);
	h.host.unmount();
});

test("卸载后旧结果不写回", async () => {
	const h = harness();
	const services = h.currentServices();
	h.render();
	h.view().uploadFiles();
	const upload = services.uploads[0];
	h.host.unmount();
	assert.equal(upload.options.signal.aborted, true, "卸载必须 abort 在途任务");
	upload.resolve({ ok: true, value: { uploaded: [{ name: "a.bin", bytes: 1 }], failed: [] } });
	await settle();
	assert.equal(h.errors.length, 0);
	assert.equal(h.reloads.length, 0);
});

test("上传需 write+upload，下载需 read+download；缺能力时零服务调用", () => {
	const noWrite = harness({ services: makeServices({ capabilities: capabilities({ write: false }) }) });
	noWrite.render();
	noWrite.view().uploadFiles();
	assert.equal(noWrite.currentServices().uploads.length, 0);
	assert.match(noWrite.errors.at(-1), /^project\.remote\.uploadFailed/);
	noWrite.host.unmount();

	const noRead = harness({ services: makeServices({ capabilities: capabilities({ read: false }) }) });
	noRead.render();
	noRead.view().downloadFile("src/a.bin");
	assert.equal(noRead.currentServices().downloads.length, 0);
	assert.match(noRead.errors.at(-1), /^project\.remote\.downloadFailed/);
	noRead.host.unmount();
});
