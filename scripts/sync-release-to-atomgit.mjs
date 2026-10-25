#!/usr/bin/env node

/**
 * scripts/sync-release-to-atomgit.mjs
 *
 * 将 GitHub 的 Release（含更新日志正文和所有附件安装包）自动同步到 AtomGit 平台。
 *
 * 凭证安全约定：
 * 1. 绝不硬编码 Token，统一从环境变量 ATOMGIT_TOKEN 获取，或通过命令行参数 --token 传入；
 * 2. 避免将带有敏感 Token 的文件提交至代码仓库；
 * 3. 支持断点续传/跳过已上传附件，避免重复上传上百 MB 的安装包。
 *
 * 去重协议（v0.7.5 事故修复）：
 * 旧版只按附件名去重，同名但内容已变（同版本号重新构建后重发版）的附件会
 * 被静默跳过，导致 AtomGit 上永久保留旧构建。现在改为「按名 + 远端实际大小」
 * 的双重校验：同名且远端大小与 GitHub 一致 → 跳过；同名但大小不一致 → 冲突
 * （显式报错并按失败处理，提示 --force-resync）；远端大小无法校验（HEAD 失败）
 * → 按旧语义跳过并警告。--force-resync 时先删除 AtomGit 上同名 Release 再重建，
 * 用于同版本号重建产物重发版。
 *
 * latest 标记约定（v0.7.4 抢占事故修复）：
 * 旧版脚本在创建/更新 release 时硬编码 release_status:'latest'，导致「谁后同步谁就是
 * 最新版」——先同步 v0.7.4 再同步 v0.7.3 后，AtomGit 上 latest 指向 v0.7.3，更新 feed
 * （releases/download/latest）会给所有用户发旧版本。现在以 GitHub 官方 latest
 * （/releases/latest）为唯一事实来源，同步完成后统一校正 AtomGit 的 latest 标记。
 *
 * 上传超时约定（workflow 卡死修复）：
 * 旧版 PUT 上传无超时，对象存储连接挂起会让 GitHub Actions job 永久卡住
 * （52 分钟无进展）。所有 fetch 调用均有超时；PUT 失败自动重试一次并计入失败清单，
 * 脚本以非 0 退出码结束，让 workflow 明确标红。
 *
 * 资产选择（v0.7.5 sidecar 补传场景）：默认行为是「GitHub 有、AtomGit 缺的全量增量同步」。
 * 只补传某类资产（如 6 平台 dsh-runtime）时用 --only，想自己逐项勾选时用 --select。
 * 选择只影响「这次传哪些附件」，不动 Release 元数据、不碰未选中的附件。
 *
 * 远端大小探测（去重有效性修复）：AtomGit 的下载 CDN 对 HEAD 返回 401（WAF 拦），
 * 旧实现只发 HEAD，导致远端大小恒为 null → 所有同名附件都落到「远端大小未知，
 * 保守跳过」，配置里承诺的「同名异大小冲突检测」实际上从未生效（v0.7.5 重建产物
 * 时靠 --force-resync 才勉强绕开）。现在 HEAD 失败后回退 Range: bytes=0-0，
 * 从 Content-Range 尾段拿真实长度（206）。
 *
 * 用法：
 *   node scripts/sync-release-to-atomgit.mjs --tag v0.7.4
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tag v0.7.2,v0.7.3,v0.7.4
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tag v0.7.5 --only 'dsh-runtime-*'
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tag v0.7.5 --select
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { actionLabel, buildAssetSelectionRows, filterAssetsByPatterns, formatAssetSize, parseAssetSelection, selectRows } from "./atomgit-asset-selection.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// API 调用超时：AtomGit API 偶发挂起，60s 足够（均为轻量 JSON 请求）
const API_TIMEOUT_MS = 60_000;
// 单文件直传对象存储的超时：与 gh release download 的 600s 对齐，
// 覆盖 ~165MB 安装包在慢速链路下的上传时间，同时兜底连接挂死场景
const UPLOAD_TIMEOUT_MS = 600_000;

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(flag, defaultValue = "") {
	const idx = args.indexOf(flag);
	if (idx !== -1 && idx + 1 < args.length) {
		return args[idx + 1];
	}
	return defaultValue;
}

const targetTags = (getArg("--tags", "") || getArg("--tag", ""))
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);
const ghRepo = getArg("--gh-repo", "ayuayue/PiDeck");
const atomgitRepo = getArg("--atomgit-repo", "ayuayue/PiDeck");
const atomgitApiBase = getArg("--api-base", "https://api.atomgit.com/api/v5");
const token = process.env.ATOMGIT_TOKEN || getArg("--token", "");
// 强制重建开关：同名 Release 在 AtomGit 已存在时先删除再全量重传（同版本号重建产物重发版场景）
const forceResync = args.includes("--force-resync");
// 资产选择（只影响「这次传哪些附件」，不动 Release 元数据与未选中的附件）：
//   --only <patterns>  逗号分隔的 glob（如 dsh-runtime-*），可重复传入；用于单独补传某类资产
//   --select           交互式列出附件让用户勾选（CI 不传，保持全量增量行为）
//   --force-upload     对本次选中的附件强制先删后传，即使远端同名同大小
//   --dry-run          只打印计划，不做任何写操作（配合 --select 可放心预演）
//   --yes              跳过交互确认（--select 脚本化调用）
// 逐个 --only 收集模式（支持 `--only a,b` 与 `--only=a,b` 两种写法）
const onlyPatterns = [];
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--only") {
		onlyPatterns.push(...String(args[i + 1] ?? "").split(","));
		i += 1;
	} else if (arg.startsWith("--only=")) {
		onlyPatterns.push(...arg.slice("--only=".length).split(","));
	}
}
const selectMode = args.includes("--select");
const forceUpload = args.includes("--force-upload");
const dryRun = args.includes("--dry-run");
const assumeYes = args.includes("--yes");

/** 带超时的 fetch 包装：所有网络请求必须经过这里，防止挂起拖死 CI job。 */
function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 只有应用版本 tag（vX.Y.Z / vX.Y.Z-beta）才允许成为 latest。
 * sidecar 资源（dsh-runner-node 等）必须挂在版本 Release 上，禁止独立占 latest。
 */
export function isAppVersionReleaseTag(tag) {
	return /^v\d+\.\d+/.test(String(tag ?? "").trim());
}

/**
 * latest 校正计划（纯函数，可单测）：
 * AtomGit 只允许一个 release 持有 release_status='latest'（更新 feed 以此为准）。
 * 以 GitHub latest 的应用版本 tag 为准；sidecar 等非版本 tag 即使被 GitHub
 * 标成 latest 也不能写到 AtomGit（会把安装包更新指错）。
 */
export function planLatestCorrection(AtomgitReleases, githubLatestTag) {
	const plan = [];
	const latestTag = isAppVersionReleaseTag(githubLatestTag) ? githubLatestTag : "";
	for (const rel of AtomgitReleases || []) {
		if (latestTag && rel.tag_name === latestTag) {
			if (rel.release_status !== "latest") {
				plan.push({ tag: rel.tag_name, release_status: "latest" });
			}
		} else if (rel.release_status === "latest") {
			plan.push({ tag: rel.tag_name, release_status: "none" });
		}
	}
	return plan;
}

/**
 * 本次目标 tag 的 release_status（纯函数，可单测）：
 * 仅当目标 tag 就是 GitHub 官方 latest 时才写 'latest'；否则不传该字段
 * （undefined → 调用方省略），避免同步旧版本时抢占最新标记。
 */
export function pickReleaseStatus(isTargetLatest) {
	return isTargetLatest ? "latest" : undefined;
}

/**
 * OpenAPI latest 与 GitHub latest 不一致时，需要「touch」回哪个 tag（纯函数，可单测）。
 *
 * 2026-10 实测：AtomGit 的 `/releases/latest` 按最近一次编辑（updated_at）返回，
 * **不看** release_status；而更新 feed（`releases/download/latest`）仍按 release_status。
 * 因此给非 latest tag 补资产/改元数据后，OpenAPI latest 会悄悄指到旧 tag；
 * macOS 手动更新检查读的正是 OpenAPI latest，会把预发布 tag 当成新版本提示用户。
 * 返回空串表示无需处理（tag 一致、或 GitHub latest 不是应用版本 tag）。
 */
export function planLatestTouch(atomgitLatestTag, githubLatestTag) {
	const target = String(githubLatestTag ?? "").trim();
	if (!isAppVersionReleaseTag(target)) return "";
	const current = String(atomgitLatestTag ?? "").trim();
	if (!current || current === target) return "";
	return target;
}

/**
 * 附件增量计划（纯函数，可单测）：内容感知去重。
 * @param {Array<{name:string,size:number}>} githubAssets GitHub 侧资产（name+size 必填）
 * @param {Array<{name:string,size:number|null}>} remoteAssets 远端已有附件（size 为
 *   HEAD 探测到的 Content-Length；探测失败为 null，表示无法校验）
 * @returns {{uploads:Array<{name:string,reason:string}>, skips:Array<{name:string,reason:string}>, conflicts:Array<{name:string,githubSize:number,remoteSize:number}>}}
 *   uploads=需要新传；skips=可安全跳过（含远端大小未知的保守跳过）；
 *   conflicts=同名但内容大小不一致，禁止静默跳过，调用方须按失败处理并提示强制重建。
 */
export function planAssetActions(githubAssets, remoteAssets) {
	const remoteByName = new Map(remoteAssets.map((a) => [a.name, a]));
	const uploads = [];
	const skips = [];
	const conflicts = [];
	for (const ga of githubAssets) {
		const ra = remoteByName.get(ga.name);
		if (!ra) {
			uploads.push({ name: ga.name, reason: "new" });
			continue;
		}
		if (ra.size == null) {
			// 远端大小探测失败（下载 URL 需鉴权/HEAD 不支持）：无法证明内容一致，
			// 但也不应阻断断点续传，保守跳过并留痕
			skips.push({ name: ga.name, reason: "remote-size-unknown" });
			continue;
		}
		if (ra.size === ga.size) {
			skips.push({ name: ga.name, reason: "same-size" });
			continue;
		}
		// 同名不同大小：同版本号重建产物重发版的典型信号，必须强制重建，禁止静默跳过
		conflicts.push({ name: ga.name, githubSize: ga.size, remoteSize: ra.size });
	}
	return { uploads, skips, conflicts };
}

// 仅 CLI 直跑时执行主流程；被测试 import 时不触发副作用（进程退出/目录创建/网络请求）
const isCliMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
	if (targetTags.length === 0) {
		console.error("❌ 错误: 必须指定同步的 Release Tag！例如: --tag v0.7.4 或 --tag v0.7.2,v0.7.3,v0.7.4");
		process.exit(1);
	}

	if (!token) {
		console.error("❌ 错误: 缺少 AtomGit Token！请通过环境变量 ATOMGIT_TOKEN 设置，或传入 --token 参数。");
		process.exit(1);
	}

	// 0. 以 GitHub 官方 latest 为唯一事实来源，供后续 release_status 决策与收尾校正
	console.log(`\n📌 查询 GitHub 官方 latest Release...`);
	let githubLatestTag = execFileSync("gh", ["api", `repos/${ghRepo}/releases/latest`, "--jq", ".tag_name"], { encoding: "utf-8" }).trim();
	if (!isAppVersionReleaseTag(githubLatestTag)) {
		console.warn(`⚠️ GitHub latest 不是应用版本 tag（${githubLatestTag}），改查最近的 v* Release…`);
		const listed = JSON.parse(execFileSync("gh", ["release", "list", "--repo", ghRepo, "--limit", "30", "--json", "tagName"], { encoding: "utf-8" }));
		githubLatestTag = (listed || []).map((r) => r.tagName).find(isAppVersionReleaseTag) || "";
	}
	console.log(`✅ GitHub latest: ${githubLatestTag || "(none)"}`);

	const skippedTags = targetTags.filter((tag) => !isAppVersionReleaseTag(tag));
	const syncTags = targetTags.filter(isAppVersionReleaseTag);
	if (skippedTags.length > 0) {
		console.log(`⏩ 跳过非应用版本 tag（会抢走 latest）: ${skippedTags.join(", ")}`);
	}
	if (syncTags.length === 0) {
		console.error("❌ 没有可同步的应用版本 tag（vX.Y.Z）。sidecar 资源请挂到当前 latest 应用 Release。");
		process.exit(1);
	}

	const failedAssets = [];

	for (const targetTag of syncTags) {
		try {
			await syncOneRelease(targetTag, githubLatestTag, failedAssets);
		} catch (err) {
			// 单个 tag 失败不中断后续 tag（多 tag 批量同步时尽量推进），最终统一以退出码暴露
			console.error(`❌ 同步 [${targetTag}] 失败:`, err.message);
			failedAssets.push({ tag: targetTag, name: "(release level)", error: err.message });
		}
	}

	if (failedAssets.length > 0) {
		console.error(`\n🚨 以下条目未成功，请重跑（已上传附件会自动跳过）:`);
		for (const f of failedAssets) {
			console.error(`   - [${f.tag}] ${f.name}: ${f.error}`);
		}
		process.exit(1);
	}

	// 无论本次同步的是哪个 tag，都把它可能抢走的 latest（feed 标记 + OpenAPI 排序）钉回去
	if (githubLatestTag) {
		await correctLatestFlag(githubLatestTag);
	}

	console.log(`\n✅ 全部同步完成。`);
}

/**
 * 逐行读取 stdin（TTY 与管道均可），EOF 时 next() 返回 null。
 *
 * 不用 readline 的 question()：流已结束（管道输入读空 / Ctrl-D）时它可能永不 resolve
 * ——实测表现为 node 因事件循环空而静默 exit 0，既没传也没报错（2026-09 实测），
 * 对「同步 Release」这种没法靠日志回滚的操作是危险的。
 */
export function createLineReader(stream) {
	let buffer = "";
	let ended = false;
	let pending = null;
	const queued = [];
	const deliver = (line) => {
		if (pending) {
			const resolve = pending;
			pending = null;
			resolve(line);
		} else {
			queued.push(line);
		}
	};
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
			deliver(line);
			idx = buffer.indexOf("\n");
		}
	});
	stream.on("end", () => {
		ended = true;
		// 残留无换行的最后一行也算一条，只有真正空了才是 EOF
		if (buffer.length > 0) {
			const line = buffer;
			buffer = "";
			deliver(line);
		}
		if (pending) {
			const resolve = pending;
			pending = null;
			resolve(null);
		}
	});
	return {
		/** @returns {Promise<string|null>} 行内容；null = EOF（调用方必须自己决定下一步） */
		next() {
			if (queued.length > 0) return Promise.resolve(queued.shift());
			if (ended) return Promise.resolve(null);
			return new Promise((resolve) => {
				pending = resolve;
			});
		},
	};
}

/**
 * 交互式勾选要同步的附件（--select）。
 *
 * 返回 { rows, forcedNames }；用户取消（确认时答非 y）或确认阶段 EOF 返回 null。
 * 选择阶段 EOF（管道只给了选择没给确认）走默认计划；确认阶段 EOF 一律当作取消——
 * 「没得到回答就上传」是这里最不能接受的行为。
 */
async function pickAssetsInteractively(rows) {
	console.log("\n本次可选附件：");
	let category = "";
	for (const row of rows) {
		if (row.category !== category) {
			category = row.category;
			console.log(`  ── ${category} ──`);
		}
		console.log(`  [${String(row.index).padStart(2)}] ${row.name.padEnd(46)} ${formatAssetSize(row.size).padStart(9)}  ${actionLabel(row)}`);
	}

	const reader = createLineReader(process.stdin);
	const ask = async (question) => {
		process.stdout.write(question);
		return reader.next();
	};

	let parsed = null;
	for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
		const answer = await ask("\n输入要同步的编号（如 1,3-5；a=全选；回车=默认计划）: ");
		if (answer === null) {
			console.log("（输入结束，采用默认计划）");
			return { rows, forcedNames: new Set() };
		}
		const result = parseAssetSelection(answer, rows.length);
		if (result.error) {
			console.error(`❌ 选择无效：${result.error}`);
			continue;
		}
		parsed = result;
	}
	if (!parsed) {
		console.error("❌ 连续 3 次输入无效，已中止（未做任何改动）。");
		process.exit(1);
	}

	if (parsed.indices.length === 0) {
		console.log("→ 采用默认计划（新增的传，已存在的跳过）");
		return { rows, forcedNames: new Set() };
	}

	const selected = selectRows(rows, parsed.indices);
	// selectRows 把「默认跳过」的行升级为上传（remote 同名同大小时必须先删后传）
	const forcedNames = new Set(selected.filter((r) => r.reason === "force-reselect").map((r) => r.name));
	console.log(`→ 已选 ${selected.length} 个：${selected.map((r) => r.name).join(", ")}`);
	if (forcedNames.size > 0) {
		console.log(`⚠️ 其中 ${forcedNames.size} 个远端已存在同名同大小附件，将先删除再重传（上传失败会留空）。`);
	}
	if (!assumeYes) {
		const confirm = (await ask("确认执行？(y/N) "))?.trim().toLowerCase();
		if (confirm !== "y" && confirm !== "yes") {
			console.log("（未确认，脚本化调用请加 --yes）");
			return null;
		}
	}
	return { rows: selected, forcedNames };
}

/** 同步单个 tag 的 release：元数据 → 附件增量上传 → 校正 latest 标记。 */
async function syncOneRelease(targetTag, githubLatestTag, failedAssets) {
	const isTargetLatest = targetTag === githubLatestTag;
	console.log(`\n========================================`);
	console.log(`🚀 同步 Release: ${targetTag} (GitHub latest=${githubLatestTag}${isTargetLatest ? "，本 tag 为最新" : ""})`);
	console.log(`GitHub 仓库:  ${ghRepo}`);
	console.log(`AtomGit 仓库: ${atomgitRepo}`);
	console.log(`========================================\n`);

	// 1. 获取 GitHub Release 详情与资产列表
	console.log(`📥 获取 GitHub Release [${targetTag}] 元数据...`);
	const raw = execFileSync("gh", ["release", "view", targetTag, "--repo", ghRepo, "--json", "name,tagName,body,assets"], { encoding: "utf-8" });
	const ghRelease = JSON.parse(raw);

	console.log(`✅ Release 名称="${ghRelease.name || targetTag}", 附件总数=${ghRelease.assets.length}`);

	// 1.5 资产过滤（--only）：只处理命中的附件，其余一律不探测、不上传
	const allGhAssets = ghRelease.assets ?? [];
	const targetAssets = filterAssetsByPatterns(allGhAssets, onlyPatterns);
	if (onlyPatterns.length > 0) {
		console.log(`🎯 --only ${onlyPatterns.join(",")}：候选附件 ${targetAssets.length}/${allGhAssets.length} 个`);
		if (targetAssets.length === 0) {
			// 模式打错时绝不静默降级成「什么都不传」，直接失败好过事后靠人眼发现没传上
			throw new Error(`--only 没有匹配到任何附件（模式: ${onlyPatterns.join(", ")}）`);
		}
	}

	// 2. 检查或创建 AtomGit Release
	const releaseUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/tags/${encodeURIComponent(targetTag)}?access_token=${encodeURIComponent(token)}`;
	let atomgitRelease = null;

	const checkRes = await fetchWithTimeout(releaseUrl);
	if (checkRes.status === 404) {
		if (dryRun) {
			// dry-run 不建 Release：远端按「附件为空」预演，计划里会显示全部待上传
			console.log(`🅳 dry-run：AtomGit 上尚无 Release [${targetTag}]，按「全部新增」预演（不创建、不上传）。`);
		} else {
			console.log(`✨ AtomGit 上尚无 Release [${targetTag}]，创建中...`);
			const createBody = {
				tag_name: targetTag,
				name: ghRelease.name || targetTag,
				body: ghRelease.body || "",
			};
			const status = pickReleaseStatus(isTargetLatest);
			if (status) createBody.release_status = status;
			const createUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases?access_token=${encodeURIComponent(token)}`;
			const createRes = await fetchWithTimeout(createUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(createBody),
			});

			if (!createRes.ok) {
				const errText = await createRes.text();
				throw new Error(`创建 AtomGit Release 失败: HTTP ${createRes.status} ${errText}`);
			}
			atomgitRelease = await createRes.json();
			console.log(`✅ 创建 AtomGit Release 成功!`);
		}
	} else if (!checkRes.ok) {
		const errText = await checkRes.text();
		throw new Error(`检查 AtomGit Release 状态异常: HTTP ${checkRes.status} ${errText}`);
	} else {
		// 常规增量路径：只更新 name/body；release_status 不在此处触碰——避免同步旧 tag 时抢占 latest
		atomgitRelease = await checkRes.json();
		const attachAssets = (atomgitRelease?.assets || []).filter((a) => a.type === "attach");
		if (forceResync) {
			// AtomGit 不提供删除整个 release 的 API（9 个 release 端点中仅附件可删）：
			// --force-resync = 删光该 tag 全部附件后全量重传，用于同版本号重建产物重发版
			if (dryRun) {
				console.log(`🅳 dry-run：--force-resync 会删除全部 ${attachAssets.length} 个附件（本次不执行）。`);
			} else {
				console.log(`♻️ --force-resync: 删除 [${targetTag}] 的全部 ${attachAssets.length} 个附件后重传...`);
				await deleteReleaseAttachments(targetTag, attachAssets);
			}
		}
		console.log(`ℹ️ AtomGit 上已存在 Release [${targetTag}]，${forceResync ? "附件已清空，" : ""}增量同步附件。`);
		if (dryRun) {
			// dry-run 就改元数据（尤其 release_status）属于破坏性副作用，必须拦住
			console.log(`🅳 dry-run：跳过 Release 元数据更新。`);
		} else {
			const patchBody = {
				name: ghRelease.name || targetTag,
				body: ghRelease.body || "",
			};
			if (isTargetLatest) patchBody.release_status = "latest";
			const patchUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}?access_token=${encodeURIComponent(token)}`;
			const patchRes = await fetchWithTimeout(patchUrl, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patchBody),
			});
			if (!patchRes.ok) {
				const errText = await patchRes.text().catch(() => "");
				// PATCH 失败不阻塞附件上传，但要留痕（latest 校正步骤会再兜底一次）
				console.error(`⚠️ 更新 Release 元数据失败: HTTP ${patchRes.status} ${errText}`);
			}
		}
	}

	// 3. 只对「本次候选资产」探测远端状态：未选中的附件不探测，省掉几十次网络往返
	const targetNames = new Set(targetAssets.map((a) => a.name));
	const freshRes = await fetchWithTimeout(releaseUrl);
	const currentRelease = freshRes.ok ? await freshRes.json() : { assets: [] };
	const attachAssets = (currentRelease.assets || []).filter((a) => a.type === "attach");
	const remoteAssets = [];
	const remoteIdByName = new Map();
	for (const a of attachAssets) {
		if (!targetNames.has(a.name)) continue;
		// 探测远端文件实际大小；失败时 size=null → 计划函数按「无法校验」保守跳过
		const size = a.browser_download_url ? await fetchRemoteAssetSize(a.browser_download_url) : null;
		if (size == null) {
			console.log(`⚠️ 无法校验远端附件 [${a.name}] 的大小（HEAD/Range 均失败），按同名跳过处理。`);
		}
		remoteAssets.push({ name: a.name, size });
		if (a.id) remoteIdByName.set(a.name, a.id);
	}
	console.log(`📦 AtomGit 已有附件 ${attachAssets.length} 个；本次候选 ${targetAssets.length} 个，其中同名已存在 ${remoteAssets.length} 个`);

	// 4. 内容感知去重计划：同名同大小 → 跳过；同名异大小 → 冲突（不静默）
	const plan = planAssetActions(
		targetAssets.map((a) => ({ name: a.name, size: a.size })),
		remoteAssets,
	);

	if (plan.conflicts.length > 0) {
		// 冲突即失败：输出明确指引后整体按失败处理（failedAssets 非空 → 非 0 退出，workflow 标红）
		for (const c of plan.conflicts) {
			console.error(`🚨 附件 [${c.name}] 内容与 GitHub 不一致（GitHub ${c.githubSize} vs AtomGit ${c.remoteSize} 字节）！`);
			failedAssets.push({ tag: targetTag, name: c.name, error: `size mismatch (github ${c.githubSize} vs remote ${c.remoteSize})` });
		}
		console.error(`💡 请使用 --force-resync 强制重建，或在 AtomGit 删除冲突附件后重跑本脚本。`);
	}
	for (const s of plan.skips) {
		console.log(`⏩ 附件 [${s.name}] ${s.reason === "same-size" ? "在 AtomGit 已存在（大小一致），跳过。" : "远端大小未知，保守跳过。"}`);
	}

	// 5. 选定本次要传的附件：默认走计划的上传项；--select 让用户逐项勾选；--force-upload 点名重传
	let rows = buildAssetSelectionRows(targetAssets, plan);
	if (forceUpload) {
		// 点名重传：连「远端已存在同大小」的行也升级为上传（否则 PUT 会拿到 409 而什么都没换）
		rows = rows.map((r) => (r.action === "skip" ? { ...r, action: "upload", reason: "force-upload" } : r));
	}
	let forcedNames = new Set(forceUpload ? rows.map((r) => r.name) : []);
	if (selectMode) {
		const picked = await pickAssetsInteractively(rows);
		if (!picked) {
			console.log("⏹️ 已取消，未做任何改动。");
			return;
		}
		rows = picked.rows;
		forcedNames = picked.forcedNames;
	}
	const assetsToSync = rows.filter((r) => r.action === "upload").map((r) => ({ name: r.name, forced: forcedNames.has(r.name) }));
	// 被点名重传的原本是「跳过」，汇总里的跳过数要相应减少
	let skipCount = plan.skips.length - rows.filter((r) => r.reason === "force-upload" || r.reason === "force-reselect").length;

	if (dryRun) {
		console.log(`\n🅳 dry-run 计划：上传 ${assetsToSync.length} 个 / 跳过 ${skipCount} 个 / 冲突 ${plan.conflicts.length} 个`);
		for (const a of assetsToSync) {
			console.log(`   ↑ ${a.name}${a.forced ? "（先删后传）" : ""}`);
		}
		console.log("dry-run：未执行任何写操作。");
		return;
	}

	let successCount = 0;

	for (let i = 0; i < assetsToSync.length; i++) {
		const asset = assetsToSync[i];
		const fileName = asset.name;
		const ghAsset = targetAssets.find((a) => a.name === fileName) ?? allGhAssets.find((a) => a.name === fileName);
		if (!ghAsset) continue;
		const fileSizeMb = (ghAsset.size / (1024 * 1024)).toFixed(2);
		console.log(`\n[${i + 1}/${assetsToSync.length}] 处理: ${fileName} (${fileSizeMb} MB)`);

		const cacheDir = path.resolve(REPO_ROOT, ".cache", "release-sync", targetTag);
		if (!fs.existsSync(cacheDir)) {
			fs.mkdirSync(cacheDir, { recursive: true });
		}
		const localFilePath = path.join(cacheDir, fileName);
		let needDownload = true;
		if (fs.existsSync(localFilePath)) {
			const stat = fs.statSync(localFilePath);
			if (stat.size === ghAsset.size) {
				console.log(`💾 使用本地缓存文件: ${localFilePath}`);
				needDownload = false;
			}
		}

		if (needDownload) {
			console.log(`⬇️ 从 GitHub 下载 ${fileName}...`);
			try {
				// 清理可能存在的未完成下载临时文件，避免把损坏文件传上去
				if (fs.existsSync(localFilePath)) {
					fs.unlinkSync(localFilePath);
				}
				// 本地调试可用代理；CI 环境未设置代理变量时不生效
				const proxyEnv = { ...process.env };
				if (process.env.USE_LOCAL_PROXY === "true" || process.env.HTTP_PROXY) {
					proxyEnv.HTTP_PROXY = process.env.HTTP_PROXY || "http://127.0.0.1:7890";
					proxyEnv.HTTPS_PROXY = process.env.HTTPS_PROXY || "http://127.0.0.1:7890";
					proxyEnv.http_proxy = process.env.http_proxy || "http://127.0.0.1:7890";
					proxyEnv.https_proxy = process.env.https_proxy || "http://127.0.0.1:7890";
				}

				execFileSync("gh", ["release", "download", targetTag, "--repo", ghRepo, "--pattern", fileName, "--dir", cacheDir, "--clobber"], { stdio: "inherit", env: proxyEnv, timeout: 600000 }); // 单个文件下载上限 10 分钟
			} catch (err) {
				console.error(`❌ 下载附件 ${fileName} 失败:`, err.message);
				if (fs.existsSync(localFilePath)) {
					try {
						fs.unlinkSync(localFilePath);
					} catch {}
				}
				failedAssets.push({ tag: targetTag, name: fileName, error: `download: ${err.message}` });
				continue;
			}
		}

		// 点名重传：远端同名附件不先删的话，直传会命中对象存储的 409 幂等语义
		//（脚本会把 409 当成功），结果是「报告成功但内容没换」。
		if (asset.forced) {
			const remoteId = remoteIdByName.get(fileName);
			if (remoteId) {
				console.log(`♻️ 强制重传：先删除远端同名附件 ${fileName} (id=${remoteId})`);
				await deleteAttachmentById(targetTag, remoteId, fileName);
			}
		}

		// 上传（含一次自动重试：presigned URL 可能过期或连接中断，重跑成本高）
		let uploaded = false;
		let lastUploadError = "";
		for (let attempt = 1; attempt <= 2 && !uploaded; attempt++) {
			if (attempt > 1) console.log(`🔁 第 ${attempt} 次尝试上传 [${fileName}]...`);
			try {
				lastUploadError = await uploadOneAsset(targetTag, fileName, localFilePath);
				uploaded = !lastUploadError;
			} catch (err) {
				lastUploadError = err.message;
			}
		}

		if (uploaded) {
			console.log(`🎉 附件 [${fileName}] 上传成功！`);
			successCount++;
		} else {
			console.error(`❌ 上传失败 [${fileName}]: ${lastUploadError}`);
			failedAssets.push({ tag: targetTag, name: fileName, error: lastUploadError });
		}
	}

	console.log(`\n========================================`);
	console.log(`🏁 [${targetTag}] 同步结束！`);
	console.log(`成功上传: ${successCount} 个附件 | 跳过已有: ${skipCount} 个附件`);
	console.log(`========================================`);

	// 4. 收尾：latest 标记与 OpenAPI latest 排序由 main 在全部 tag 同步后统一校正
	// （同步任意 tag 都可能抢走 OpenAPI latest，不能只在同步 latest tag 时校正）
}

/** 单附件上传：申请 presigned URL → PUT 直传对象存储。返回空串表示成功，否则为错误信息。 */
async function uploadOneAsset(targetTag, fileName, localFilePath) {
	// 获取 AtomGit 预签名上传 URL
	const uploadUrlEndpoint = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}/upload_url?access_token=${encodeURIComponent(token)}&file_name=${encodeURIComponent(fileName)}`;
	const uploadUrlRes = await fetchWithTimeout(uploadUrlEndpoint);
	if (!uploadUrlRes.ok) {
		const errText = await uploadUrlRes.text().catch(() => "");
		return `获取上传凭据失败: HTTP ${uploadUrlRes.status} ${errText}`;
	}

	const uploadInfo = await uploadUrlRes.json();
	if (!uploadInfo.url) {
		return `返回的上传凭据无效: ${JSON.stringify(uploadInfo).slice(0, 200)}`;
	}

	// PUT 直传到 AtomGit 对象存储；必须带超时——否则连接挂起会永久卡死 CI job
	const fileStream = fs.createReadStream(localFilePath);
	const putHeaders = {
		...(uploadInfo.headers || {}),
		"Content-Length": String(fs.statSync(localFilePath).size),
	};
	const putRes = await fetchWithTimeout(uploadInfo.url, { method: "PUT", headers: putHeaders, body: fileStream, duplex: "half" }, UPLOAD_TIMEOUT_MS);
	if (putRes.status === 409) {
		// 409 = 附件已存在（AtomGit 对象存储幂等语义）：视为成功，与「按名去重」断点续传逻辑一致
		return "";
	}
	if (!putRes.ok) {
		const putErr = await putRes.text().catch(() => "");
		return `PUT 失败: HTTP ${putRes.status} ${putErr.slice(0, 200)}`;
	}
	return "";
}

/**
 * 探测远端附件真实大小。
 * AtomGit 的 Release API 不返回附件大小字段（仅 name/type/id），下载 CDN 对 HEAD
 * 返回 401（WAF 拦 HEAD），旧实现只发 HEAD → 恒为 null → 所有同名附件都被归到
 * 「远端大小未知，保守跳过」，头注释承诺的「同名异大小冲突检测」从未生效。
 * 现在 HEAD 不成时回退 `Range: bytes=0-0`（实测 206 + Content-Range），
 * 从尾段取真实总长；两者都失败仍然返回 null 表示「无法校验」。
 */
async function fetchRemoteAssetSize(downloadUrl) {
	try {
		const sep = downloadUrl.includes("?") ? "&" : "?";
		const url = `${downloadUrl}${sep}access_token=${encodeURIComponent(token)}`;
		const res = await fetchWithTimeout(url, { method: "HEAD" }, API_TIMEOUT_MS);
		if (res.ok) {
			const len = res.headers.get("content-length");
			if (len) return Number(len);
		}
	} catch {
		// HEAD 异常不能直接放弃：继续尝试 Range 探测
	}
	try {
		// 不带 token（带 token 会被 CDN 当成异常参数返回 404），公开下载 URL 即可读长度
		const res = await fetchWithTimeout(downloadUrl, { headers: { Range: "bytes=0-0" } }, API_TIMEOUT_MS);
		if (res.status === 206) {
			const total = res.headers.get("content-range")?.split("/")[1];
			return total ? Number(total) : null;
		}
		if (res.status === 200) {
			const len = res.headers.get("content-length");
			return len ? Number(len) : null;
		}
		return null;
	} catch {
		// 探测失败不阻塞流程：计划函数会按「无法校验」保守跳过
		return null;
	}
}

/**
 * 删除 AtomGit 上指定 tag 的 Release 的全部附件（--force-resync 用）。
 * AtomGit 不提供删除整个 Release 的 API（release 对象无 id，端点只有
 * DELETE /releases/{tag}/attach_files/{attachFileId}），因此只能逐个删除附件，
 * 删光后走增量路径全量重传（同名附件不再被 409/去重拦截）。
 */
async function deleteReleaseAttachments(targetTag, attachments) {
	let deleted = 0;
	for (const a of attachments) {
		if (!a.id) {
			// 无 id 无法定位删除（正常响应均携带 id，如 200904）；留到上传阶段按同名处理
			console.error(`⚠️ 附件 [${a.name}] 缺少 id，无法删除，将在上传阶段按同名跳过/409 处理。`);
			continue;
		}
		await deleteAttachmentById(targetTag, a.id, a.name);
		deleted++;
	}
	console.log(`🗑️ 已删除 ${deleted} 个附件。`);
}

/** 删除单个附件（--force-upload 点名单传、--force-resync 批量删除共用）。 */
async function deleteAttachmentById(targetTag, id, name) {
	const delUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}/attach_files/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}`;
	const res = await fetchWithTimeout(delUrl, { method: "DELETE" });
	if (!res.ok) {
		const errText = await res.text().catch(() => "");
		throw new Error(`删除附件 [${name}] (id=${id}) 失败: HTTP ${res.status} ${errText}`);
	}
	console.log(`  🗑️ 已删除旧附件 ${name}`);
}

/**
 * latest 标记校正（仅 GitHub latest tag 同步后调用）：
 * 先读 AtomGit 全部 release，按 GitHub latest 事实纠正差异；
 * 平台若拒绝 'none' 状态值则只警告不阻塞（通常写新 latest 时旧标记会自动降级）。
 */
async function correctLatestFlag(githubLatestTag) {
	try {
		const listUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases?access_token=${encodeURIComponent(token)}&per_page=50`;
		const listRes = await fetchWithTimeout(listUrl);
		if (!listRes.ok) {
			console.error(`⚠️ 无法读取 AtomGit release 列表（HTTP ${listRes.status}），跳过 latest 校正。`);
			return;
		}
		const releases = await listRes.json();
		const plan = planLatestCorrection(releases, githubLatestTag);
		if (plan.length === 0) {
			console.log(`✅ latest 标记已是最新: ${githubLatestTag}`);
		}
		for (const item of plan) {
			const patchUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(item.tag)}?access_token=${encodeURIComponent(token)}`;
			const rel = (releases || []).find((r) => r.tag_name === item.tag);
			const patchRes = await fetchWithTimeout(patchUrl, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				// PATCH 接口要求 name/body 必填：带上现有值，仅改 release_status
				body: JSON.stringify({ name: rel?.name ?? item.tag, body: rel?.body ?? "", release_status: item.release_status }),
			});
			if (patchRes.ok) {
				console.log(`✅ latest 校正: [${item.tag}] → release_status=${item.release_status}`);
			} else {
				const errText = await patchRes.text().catch(() => "");
				console.error(`⚠️ latest 校正 [${item.tag}] → ${item.release_status} 失败: HTTP ${patchRes.status} ${errText}（可在 AtomGit 网页端手动调整）`);
			}
		}
		const feedCheckUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/latest?access_token=${encodeURIComponent(token)}`;
		const feedCheck = await fetchWithTimeout(feedCheckUrl);
		const latestRelease = feedCheck.ok ? await feedCheck.json() : { tag_name: "" };
		console.log(`🔎 当前 AtomGit latest release: ${latestRelease.tag_name ?? latestRelease.name ?? "?"}`);

		const touchTag = planLatestTouch(latestRelease.tag_name, githubLatestTag);
		if (!touchTag) return;
		// 空更新真正的 latest release 把 updated_at 顶到最新，恢复 OpenAPI latest 指向。
		// 语义不变：name/body 传现有值，release_status 不传（保持原有 latest 标记）。
		let touchRelease = (releases || []).find((r) => r.tag_name === touchTag);
		if (!touchRelease) {
			const tagRes = await fetchWithTimeout(`${atomgitApiBase}/repos/${atomgitRepo}/releases/tags/${encodeURIComponent(touchTag)}?access_token=${encodeURIComponent(token)}`);
			if (tagRes.ok) touchRelease = await tagRes.json();
		}
		const touchRes = await fetchWithTimeout(`${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(touchTag)}?access_token=${encodeURIComponent(token)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: touchRelease?.name ?? touchTag, body: touchRelease?.body ?? "" }),
		});
		if (!touchRes.ok) {
			const errText = await touchRes.text().catch(() => "");
			console.error(`⚠️ OpenAPI latest 钉回 [${touchTag}] 失败: HTTP ${touchRes.status} ${errText}（macOS 手动更新检查可能读到旧 tag）`);
			return;
		}
		const verifyRes = await fetchWithTimeout(feedCheckUrl);
		const verified = verifyRes.ok ? await verifyRes.json() : { tag_name: "" };
		console.log(`✅ OpenAPI latest 已钉回 ${verified.tag_name ?? "?"}（touch ${touchTag}）`);
	} catch (err) {
		console.error(`⚠️ latest 校正异常（不阻塞主流程）:`, err.message);
	}
}

if (isCliMain) {
	main().catch((err) => {
		console.error("Fatal Error:", err);
		process.exit(1);
	});
}
