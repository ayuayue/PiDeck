#!/usr/bin/env node

/**
 * scripts/sync-release-to-atomgit.mjs
 *
 * 把 GitHub Release 的正文与附件同步到 AtomGit 的同名 Release。
 *
 * 约定沿用 PiDeck 的那份脚本（同一套接口与旗标），但只保留 V2 用得到的部分：
 * 没有 Electron 的 sidecar/runtime 资产筛选，也不做交互式勾选。
 *
 * 1. 凭证只从环境变量来（ATOMGIT_TOKEN、GH_TOKEN），绝不硬编码，也不写进仓库。
 * 2. 去重按「附件名 + 远端实际大小」：同名同大小跳过，同名异大小算冲突并失败，
 *    避免同版本号重建产物后 AtomGit 静默留下旧包。--force-resync 先删附件再重传。
 * 3. latest 只跟着 NSGo 的 nsgo-stable 走；不读取共享仓库的 Electron latest。
 * 4. 所有请求都有超时：对象存储连接挂起不能让 CI job 卡死。
 *
 * 用法：
 *   node scripts/sync-release-to-atomgit.mjs --tags nsgo-v2.0.0
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tags "nsgo-v2.0.0,nsgo-stable"
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tags nsgo-stable --force-resync
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tags nsgo-v2.0.0 --dry-run
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 600_000;

const args = process.argv.slice(2);
const arg = (flag, fallback = "") => {
	const i = args.indexOf(flag);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
};

const tags = (arg("--tags", "") || arg("--tag", ""))
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);
const ghRepo = arg("--gh-repo", "ayuayue/PiDeck");
const atomgitRepo = arg("--atomgit-repo", "ayuayue/PiDeck-V2");
const apiBase = arg("--api-base", "https://api.atomgit.com/api/v5");
const token = process.env.ATOMGIT_TOKEN || arg("--token", "");
const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const forceResync = args.includes("--force-resync");
const dryRun = args.includes("--dry-run");

if (!tags.length) {
	console.error("缺少 --tags（可逗号分隔多个 NSGo 标签，如 nsgo-v2.0.0）");
	process.exit(2);
}
if (!token) {
	console.error("缺少 ATOMGIT_TOKEN：AtomGit 访问令牌需要在仓库 Secrets 里配置");
	process.exit(2);
}

function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function githubHeaders(extra = {}) {
	return ghToken ? { ...extra, Authorization: `Bearer ${ghToken}` } : extra;
}

/** AtomGit 的写接口仍接受 access_token 查询参数，沿用 PiDeck 的调用方式。 */
function atomgitUrl(pathname, params = {}) {
	const url = new URL(`${apiBase}/repos/${atomgitRepo}${pathname}`);
	url.searchParams.set("access_token", token);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

async function githubRelease(tag) {
	const res = await fetchWithTimeout(
		`https://api.github.com/repos/${ghRepo}/releases/tags/${encodeURIComponent(tag)}`,
		{ headers: githubHeaders({ Accept: "application/vnd.github+json" }) },
	);
	if (!res.ok) {
		throw new Error(`读取 GitHub Release [${tag}] 失败: HTTP ${res.status} ${await res.text().catch(() => "")}`);
	}
	return res.json();
}

async function githubLatestTag() {
	const res = await fetchWithTimeout(`https://api.github.com/repos/${ghRepo}/releases/tags/nsgo-stable`, {
		headers: githubHeaders({ Accept: "application/vnd.github+json" }),
	});
	if (!res.ok) return "";
	const body = await res.json().catch(() => ({}));
	return body?.tag_name ?? "";
}

async function atomgitRelease(tag) {
	const res = await fetchWithTimeout(atomgitUrl(`/releases/tags/${encodeURIComponent(tag)}`));
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`检查 AtomGit Release [${tag}] 失败: HTTP ${res.status} ${await res.text().catch(() => "")}`);
	}
	return res.json();
}

function attachments(release) {
	return (release?.assets ?? []).filter((a) => a.type === "attach");
}

/** 远端附件大小：AtomGit 的 HEAD 会被 WAF 拦成 401，回退 Range 取 Content-Range。 */
async function remoteAssetSize(downloadUrl) {
	if (!downloadUrl) return null;
	try {
		const res = await fetchWithTimeout(downloadUrl, { method: "HEAD" });
		const len = res.ok ? res.headers.get("content-length") : "";
		if (len) return Number(len);
	} catch {
		// HEAD 失败继续用 Range 探测。
	}
	try {
		const res = await fetchWithTimeout(downloadUrl, { headers: { Range: "bytes=0-0" } });
		if (res.status === 206) {
			const total = res.headers.get("content-range")?.split("/")[1];
			return total ? Number(total) : null;
		}
		if (res.status === 200) {
			const len = res.headers.get("content-length");
			return len ? Number(len) : null;
		}
	} catch {
		// 探测失败按「无法校验」处理。
	}
	return null;
}

/** 同名同大小跳过，同名异大小冲突，缺的上传。 */
function planAssets(githubAssets, remoteByName) {
	const plan = [];
	for (const asset of githubAssets) {
		if (!remoteByName.has(asset.name)) {
			plan.push({ name: asset.name, action: "upload", reason: "新附件" });
			continue;
		}
		const size = remoteByName.get(asset.name);
		if (size == null) {
			plan.push({ name: asset.name, action: "skip", reason: "远端大小无法校验" });
		} else if (size === asset.size) {
			plan.push({ name: asset.name, action: "skip", reason: "同名同大小" });
		} else {
			plan.push({ name: asset.name, action: "conflict", githubSize: asset.size, remoteSize: size });
		}
	}
	return plan;
}

async function downloadAsset(asset, dir) {
	const file = path.join(dir, asset.name);
	const res = await fetchWithTimeout(
		asset.url,
		{ headers: githubHeaders({ Accept: "application/octet-stream" }) },
		UPLOAD_TIMEOUT_MS,
	);
	if (!res.ok || !res.body) {
		throw new Error(`下载 GitHub 附件 [${asset.name}] 失败: HTTP ${res.status}`);
	}
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
	return file;
}

/** 取上传凭据后 PUT 到对象存储；409 表示同名已在，按成功处理。 */
async function uploadAsset(tag, file) {
	const name = path.basename(file);
	const ticketRes = await fetchWithTimeout(atomgitUrl(`/releases/${encodeURIComponent(tag)}/upload_url`, { file_name: name }));
	if (!ticketRes.ok) {
		return `获取上传凭据失败: HTTP ${ticketRes.status} ${await ticketRes.text().catch(() => "")}`;
	}
	const ticket = await ticketRes.json().catch(() => ({}));
	if (!ticket.url) {
		return `上传凭据无效: ${JSON.stringify(ticket).slice(0, 200)}`;
	}
	const putRes = await fetchWithTimeout(
		ticket.url,
		{
			method: "PUT",
			headers: { ...(ticket.headers ?? {}), "Content-Length": String(fs.statSync(file).size) },
			body: fs.createReadStream(file),
			duplex: "half",
		},
		UPLOAD_TIMEOUT_MS,
	);
	if (putRes.status === 409) return "";
	if (!putRes.ok) {
		return `PUT 失败: HTTP ${putRes.status} ${(await putRes.text().catch(() => "")).slice(0, 200)}`;
	}
	return "";
}

async function deleteAttachment(tag, id, name) {
	const res = await fetchWithTimeout(atomgitUrl(`/releases/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(id)}`), { method: "DELETE" });
	if (!res.ok) {
		throw new Error(`删除附件 [${name}] (id=${id}) 失败: HTTP ${res.status}`);
	}
	console.log(`  🗑️ 已删除旧附件 ${name}`);
}

async function syncTag(tag, latestTag, tmpDir) {
	const release = await githubRelease(tag);
	if (release.prerelease) {
		console.log(`⏭️ [${tag}] 是预发布（dev 通道），AtomGit 只镜像 stable，跳过。`);
		return [];
	}
	console.log(`📦 [${tag}] GitHub 附件 ${release.assets.length} 个`);
	const isLatest = tag === latestTag;

	let remote = await atomgitRelease(tag);
	if (!remote) {
		if (dryRun) {
			console.log(`🅳 dry-run：AtomGit 上还没有 [${tag}]，按「全部新增」预演。`);
		} else {
			const body = { tag_name: tag, name: release.name || tag, body: release.body || "" };
			if (isLatest) body.release_status = "latest";
			const res = await fetchWithTimeout(atomgitUrl("/releases"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				throw new Error(`创建 AtomGit Release [${tag}] 失败: HTTP ${res.status} ${await res.text().catch(() => "")}`);
			}
			console.log(`✅ 已创建 AtomGit Release [${tag}]`);
		}
	} else if (forceResync) {
		const attach = attachments(remote);
		if (dryRun) {
			console.log(`🅳 dry-run：--force-resync 会先删除 [${tag}] 的 ${attach.length} 个附件（本次不执行）。`);
		} else {
			console.log(`♻️ --force-resync：删除 [${tag}] 的 ${attach.length} 个附件后重传`);
			for (const asset of attach) {
				if (asset.id) await deleteAttachment(tag, asset.id, asset.name);
			}
		}
	} else if (dryRun) {
		console.log(`🅳 dry-run：跳过 [${tag}] 的 Release 元数据更新。`);
	} else {
		// 只有 NSGo stable 通道继承 latest；同步版本 tag 时不碰这个标记。
		const body = { name: release.name || tag, body: release.body || "" };
		if (isLatest) body.release_status = "latest";
		const res = await fetchWithTimeout(atomgitUrl(`/releases/${encodeURIComponent(tag)}`), {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			console.error(`⚠️ 更新 [${tag}] 元数据失败: HTTP ${res.status}（附件同步继续）`);
		}
	}

	remote = (await atomgitRelease(tag)) ?? { assets: [] };
	const remoteByName = new Map();
	if (!(dryRun && forceResync)) {
		for (const asset of attachments(remote)) {
			remoteByName.set(asset.name, await remoteAssetSize(asset.browser_download_url));
		}
	}

	const plan = planAssets(release.assets, remoteByName);
	const conflicts = plan.filter((p) => p.action === "conflict");
	if (conflicts.length) {
		for (const c of conflicts) {
			console.error(`🚨 [${c.name}] 内容与 GitHub 不一致（GitHub ${c.githubSize} vs AtomGit ${c.remoteSize} 字节）`);
		}
		console.error("💡 同版本号重建过产物就用 --force-resync 重跑；否则先在 AtomGit 删掉冲突附件。");
		return conflicts.map((c) => ({ tag, name: c.name, error: "size mismatch" }));
	}

	const failures = [];
	for (const item of plan) {
		if (item.action === "skip") {
			console.log(`  ⏭️ ${item.name}（${item.reason}）`);
			continue;
		}
		if (dryRun) {
			console.log(`  🅳 待上传 ${item.name}`);
			continue;
		}
		const asset = release.assets.find((a) => a.name === item.name);
		let lastError = "";
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const file = await downloadAsset(asset, tmpDir);
				lastError = await uploadAsset(tag, file);
				fs.rmSync(file, { force: true });
			} catch (err) {
				lastError = String(err?.message ?? err);
			}
			if (!lastError) break;
		}
		if (lastError) {
			console.error(`  ✗ ${item.name}: ${lastError}`);
			failures.push({ tag, name: item.name, error: lastError });
		} else {
			console.log(`  ⬆️ ${item.name}`);
		}
	}
	return failures;
}

async function main() {
	const latestTag = await githubLatestTag();
	if (latestTag) console.log(`🔎 GitHub NSGo stable: ${latestTag}`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-v2-sync-"));
	let failures = [];
	try {
		for (const tag of tags) {
			failures = failures.concat(await syncTag(tag, latestTag, tmpDir));
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	if (!dryRun && latestTag) {
		const res = await fetchWithTimeout(atomgitUrl("/releases/latest")).catch(() => null);
		const now = res?.ok ? (await res.json().catch(() => ({}))).tag_name : "";
		if (now && now !== latestTag) {
			console.error(`⚠️ AtomGit latest 指向 ${now}，GitHub 是 ${latestTag}；可在 AtomGit 网页端把它设为最新。`);
		}
	}

	if (failures.length) {
		console.error(`❌ ${failures.length} 个附件没传上去：`);
		for (const f of failures) console.error(`  - [${f.tag}] ${f.name}: ${f.error}`);
		process.exitCode = 1;
	} else {
		console.log("✅ 同步完成");
	}
}

main().catch((err) => {
	console.error(`❌ 同步失败: ${err?.message ?? err}`);
	process.exitCode = 1;
});
