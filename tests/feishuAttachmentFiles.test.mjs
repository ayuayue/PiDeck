import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { readFeishuBridgeSources } from "./helpers/feishuBridgeSources.mjs";

/**
 * 飞书附件落盘契约（issue #427 追加一/追加二）。
 *
 * 追加一：file 分支过去只把文件名拼进 prompt，下载到内存的字节被丢掉——Agent 看到
 * 「[附件: xx.pdf]」会以为自己拿到了原文（幻觉源）。现在必须落盘到临时目录、把绝对路径
 * 与读取指令一起交给 Agent，并在 run 收尾时删除临时文件；文件名来自用户，落盘前必须清洗。
 * 追加二：单文件 200MB / 下载闸 256MB / 暂存 50 个 100MB。
 */

const load = createTsSandbox({});
const { MAX_ATTACHMENT_BYTES, PENDING_ATTACHMENT_MAX_BYTES, PENDING_ATTACHMENT_MAX_COUNT, formatAttachmentSize, safeAttachmentFileName } = load("src/main/feishu/attachmentFiles.ts");

const bridge = readFeishuBridgeSources();
const i18n = readFileSync("src/main/feishu/FeishuI18n.ts", "utf8");

test("file attachments are written to disk and the prompt carries the absolute path", () => {
	assert.match(bridge, /join\(\s*tmpdir\(\),\s*"pi-feishu-files"\s*\)/, "文件必须落到独立临时目录");
	assert.match(bridge, /writeFileSync\(fp, att\.data\)/, "文件必须真的写盘（不能只拼文件名）");
	assert.match(bridge, /savedFiles\.push\(\{ path: fp, name: att\.fileName, size: att\.data\.length \}\)/);
	assert.match(bridge, /文件已保存到本地，务必用 Read\/文件工具读取原文，禁止只看文件名猜内容/, "prompt 必须带读取指令，堵住「只看文件名猜内容」");
	assert.match(bridge, /原名 \$\{file\.name\}.*\$\{formatAttachmentSize\(file\.size\)\}/, "prompt 必须给原文件名与大小");
	assert.doesNotMatch(bridge, /\[附件: \$\{names\}\]/, "旧的文件名拼接 prompt 必须移除");
});

test("temp attachments are deleted when the run settles", () => {
	const cleanup = bridge.match(/const cleanupPaths = \[\.\.\.savedImages, \.\.\.savedFiles\.map\(\(file\) => file\.path\)\];[\s\S]*?for \(const fp of cleanupPaths\) unlink\(fp, \(\) => \{\}\);/);
	assert.ok(cleanup, "finally 必须同时清理图片与文件临时路径");
});

test("user-supplied file names cannot escape the temp directory", () => {
	const traversal = safeAttachmentFileName("../../etc/passwd");
	assert.equal(traversal, "_.._etc_passwd", "路径分隔符必须替换、前导点必须去掉");
	assert.ok(!traversal.includes("/") && !traversal.includes("\\"), "结果里不得残留路径分隔符");
	assert.ok(!traversal.startsWith("."), "结果不得以点开头");
	assert.ok(!safeAttachmentFileName("....//evil.pdf").includes("/"));
	assert.ok(!safeAttachmentFileName("a\\b\\c.pdf").includes("\\"));
	assert.ok(!safeAttachmentFileName("x:y*z?.pdf").includes(":"));
	assert.equal(safeAttachmentFileName("...hidden.pdf"), "hidden.pdf", "前导点必须去掉");
	assert.equal(safeAttachmentFileName("café-报告 2026.pdf"), "caf_-报告_2026.pdf", "非白名单字符替换为下划线，中文保留");
	assert.equal(safeAttachmentFileName(""), "attachment", "空名必须有兜底");
	assert.equal(safeAttachmentFileName(".."), "attachment", "纯点必须走兜底");
	assert.equal(safeAttachmentFileName("a".repeat(300)).length, 120, "超长名必须截断");
});

test("size formatting stays human readable", () => {
	assert.equal(formatAttachmentSize(512), "512B");
	assert.equal(formatAttachmentSize(2048), "2KB");
	assert.equal(formatAttachmentSize(1536), "1.5KB");
	assert.equal(formatAttachmentSize(MAX_ATTACHMENT_BYTES), "200MB");
});

test("attachment limits follow the 200MB / 256MB / 50 items request", () => {
	assert.equal(MAX_ATTACHMENT_BYTES, 200 * 1024 * 1024);
	assert.equal(PENDING_ATTACHMENT_MAX_COUNT, 50);
	assert.equal(PENDING_ATTACHMENT_MAX_BYTES, 100 * 1024 * 1024);
	assert.match(bridge, /MAX_RESOURCE_DOWNLOAD_BYTES = 256 \* 1024 \* 1024/);
	assert.match(bridge, /heldCount \+ incomingCount > PENDING_ATTACHMENT_MAX_COUNT/);
	assert.match(bridge, /heldBytes \+ incomingBytes > PENDING_ATTACHMENT_MAX_BYTES/);
});

test("oversize copy takes the limit from the constant and exists in both locales", () => {
	assert.match(bridge, /feishuT\(this\.locale, "attachment\.fileTooLarge", \{ limit: formatAttachmentSize\(MAX_ATTACHMENT_BYTES\) \}\)/);
	for (const key of ["attachment.fileTooLarge", "attachment.pendingFull"]) {
		const occurrences = i18n.split(`"${key}"`).length - 1;
		assert.equal(occurrences, 2, `${key} 必须在 zhCN 与 enUS 词典各出现一次`);
	}
	assert.doesNotMatch(i18n, /attachment\.fileTooLarge50/, "旧的 50MB 文案键名必须移除");
});
