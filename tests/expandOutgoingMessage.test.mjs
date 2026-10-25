import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 发送管线展开边界（W1 回归）。
 *
 * 背景：三个展开器曾各自对整个文本跑全局替换，先后顺序是「引用 → 会话引用 → 模板」。
 * 后一个展开器不避让前一个已生成的块，导致引用/会话上下文里的 `/模板名`、`&会话名`
 * 被替换成块正文——发给模型的「引用原文」与实际被引用的内容不一致（2026-10 实测复现）。
 *
 * 规则：已生成的块区间（含块内正文）对后续展开只读。
 */

const templates = [
	{ name: "commit", description: "提交", content: "COMMIT-TEMPLATE-BODY" },
	{ name: "parallel-review", description: "评审", content: "REVIEW-TEMPLATE-BODY" },
];

function composerBehavior() {
	return loadTsCommonJs("src/renderer/src/composerBehavior.ts");
}

test("引用块内的 /模板名 不被展开（回归：引用原文被改写）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const quoted = `<quoted_context label="x" message_id="m1">\n用户说：先跑 /commit 再发版\n</quoted_context>\n\n这个引用对吗？`;
	const out = expandPromptTemplates(quoted, templates);
	assert.ok(!out.message.includes("COMMIT-TEMPLATE-BODY"), "引用块正文里的 /commit 必须保持原文");
	assert.ok(out.message.includes("用户说：先跑 /commit 再发版"));
});

test("引用块外的 /模板名 仍然正常展开", () => {
	const { expandPromptTemplates } = composerBehavior();
	const quoted = `<quoted_context label="x" message_id="m1">\n记录：/commit\n</quoted_context>\n\n/commit`;
	const out = expandPromptTemplates(quoted, templates);
	assert.ok(out.message.includes("COMMIT-TEMPLATE-BODY"), "块外的 /commit 必须展开");
	// 块内那份保持原文：全文只应出现一次展开正文
	assert.equal(out.message.split("COMMIT-TEMPLATE-BODY").length - 1, 1);
});

test("会话引用块内的 /模板名 同样不被展开", () => {
	const { expandPromptTemplates } = composerBehavior();
	const session = `<referenced_session name="历史会话">\n[User]: 用 /commit 提交\n</referenced_session>\n\n接着说`;
	const out = expandPromptTemplates(session, templates);
	assert.ok(!out.message.includes("COMMIT-TEMPLATE-BODY"));
});

test("嵌套块只保护外层区间（引用里含技能块）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const nested = `<quoted_context label="x" message_id="m1">\n<skill name="demo" location="a" >SKILL-BODY /commit</skill>\n</quoted_context>`;
	const out = expandPromptTemplates(nested, templates);
	assert.ok(!out.message.includes("COMMIT-TEMPLATE-BODY"), "外层块内的技能正文同样受保护");
});

test("已展开的模板块不会被二次展开（队列重放路径）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const once = expandPromptTemplates('<prompt_template name="parallel-review">\nREVIEW-TEMPLATE-BODY\n</prompt_template> 补充', templates);
	assert.ok(!once.message.includes("COMMIT-TEMPLATE-BODY"));
	// 二次运行时正文不再被改写（此时文本里没有 /命令，不应产生新块）
	const twice = expandPromptTemplates(once.message, templates);
	assert.equal(twice.message, once.message);
});

test("会话引用展开：&名称 在引用块内不被展开", async () => {
	const { expandSessionReferences } = loadTsCommonJs("src/renderer/src/sending/outgoingExpansion.ts");
	const quoted = `<quoted_context label="x" message_id="m1">\n记录：&历史会话 说过\n</quoted_context>\n\n真的吗`;
	const out = await expandSessionReferences(quoted, [{ id: "s1", name: "历史会话" }], () => "READ-BODY");
	assert.ok(!out.includes("READ-BODY"), "引用块内的 &名称 必须保持原文");
	assert.ok(out.includes("&历史会话"));
});

test("会话引用展开：块外 &名称 正常展开成 referenced_session", async () => {
	const { expandSessionReferences } = loadTsCommonJs("src/renderer/src/sending/outgoingExpansion.ts");
	const out = await expandSessionReferences("对比一下 &历史会话", [{ id: "s1", name: "历史会话" }], () => "READ-BODY");
	assert.ok(out.includes(`<referenced_session name="历史会话">`));
	assert.ok(out.includes("READ-BODY"));
});

test("会话引用展开：正文含 $& 不被当替换模式（函数替换）", async () => {
	const { expandSessionReferences } = loadTsCommonJs("src/renderer/src/sending/outgoingExpansion.ts");
	const out = await expandSessionReferences("看 &历史会话", [{ id: "s1", name: "历史会话" }], () => "价格 $& 元");
	assert.ok(out.includes("价格 $& 元"), `替换串里的 $& 必须原样保留，实际: ${out}`);
});

test("会话引用展开：取不到内容时整段丢弃（历史行为）", async () => {
	const { expandSessionReferences } = loadTsCommonJs("src/renderer/src/sending/outgoingExpansion.ts");
	const out = await expandSessionReferences("看 &空会话 吧", [{ id: "s1", name: "空会话" }], () => "");
	assert.equal(out, "看  吧");
});

test("会话引用展开：名称按长度降序，短名不吃长名前缀", async () => {
	const { expandSessionReferences } = loadTsCommonJs("src/renderer/src/sending/outgoingExpansion.ts");
	const out = await expandSessionReferences(
		"&架构 与 &架构评审",
		[
			{ id: "a", name: "架构" },
			{ id: "b", name: "架构评审" },
		],
		(session) => `BODY-${session.id}`,
	);
	assert.ok(out.includes("BODY-b"), "长名必须先被自己替换");
	assert.ok(out.includes(`name="架构评审"`));
});

test("无保护区时替换内容里的 $& / $` 不被当替换模式（字符串形态的老坑）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/tpl", [{ name: "tpl", description: "", content: "价格 $& 与 $` 与 $'" }]);
	assert.ok(out.message.includes("价格 $& 与 $` 与 $'"), `替换正文必须原样保留，实际: ${out.message}`);
});

test("相邻两个命令都展开（单次 replace 吃掉分隔符的既有缺陷）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/commit /parallel-review", templates);
	assert.ok(out.message.includes("COMMIT-TEMPLATE-BODY"));
	assert.ok(out.message.includes("REVIEW-TEMPLATE-BODY"), `紧随其后的命令也必须展开，实际: ${out.message}`);
});

test("相邻命令与保护区组合：块内不动、块外两个都展开", () => {
	const { expandPromptTemplates } = composerBehavior();
	const text = `<quoted_context label="x" message_id="m1">\n记录 /commit\n</quoted_context> /commit /parallel-review`;
	const out = expandPromptTemplates(text, templates);
	assert.equal(out.message.split("COMMIT-TEMPLATE-BODY").length - 1, 1, "块内那份不展开、块外那份展开");
	assert.ok(out.message.includes("REVIEW-TEMPLATE-BODY"));
});

test("后端接管的命令不展开（DSH host 命令 / pi 扩展命令）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/commit", templates, { reservedNames: new Set(["commit"]) });
	assert.equal(out.message, "/commit", "被后端接管的命令必须原样保留，否则命令永远不会执行");
	assert.equal(out.description, undefined);
});

test("保留集只挡同名命令，其余照常展开", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/commit /parallel-review", templates, { reservedNames: new Set(["commit"]) });
	assert.ok(out.message.startsWith("/commit "), "commit 保持原样交给后端");
	assert.ok(out.message.includes("REVIEW-TEMPLATE-BODY"), "未保留的模板照常展开");
});

test("保留命令与保护区可共存：块内不动、块外让路/展开", () => {
	const { expandPromptTemplates } = composerBehavior();
	const text = `<quoted_context label="x" message_id="m1">\n/commit\n</quoted_context> /commit /parallel-review`;
	const out = expandPromptTemplates(text, templates, { reservedNames: new Set(["commit"]) }).message;
	assert.equal(out.split("COMMIT-TEMPLATE-BODY").length - 1, 0, "引用内与保留命令都不展开");
	assert.ok(out.includes("REVIEW-TEMPLATE-BODY"));
});

test("参数替换：$@ 填进正文原位，且块外仍留可见副本（气泡折成 chip 后用户还看得见）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/pr 重构 高优先", [{ name: "pr", description: "", content: "Focus:\n\n$@\n\nDone" }]).message;
	assert.ok(out.includes("Focus:\n\n重构 高优先\n\nDone"), `正文必须带参数（模型看到原位插入），实际: ${JSON.stringify(out)}`);
	// 块外副本：模板正文会被折成 chip，只放在正文里的话用户发完就看不见自己的话
	assert.ok(out.includes("</prompt_template>\n\n重构 高优先"), `块外必须有可见副本，实际: ${JSON.stringify(out.slice(-60))}`);
	assert.equal(out.split("重构").length - 1, 2, "正文一份 + 块外一份");
});

test("参数替换：$1 位置参数进正文", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/pr 高", [{ name: "pr", description: "", content: "Level: $1" }]).message;
	assert.ok(out.includes("Level: 高"));
	assert.ok(!out.includes("$1"));
});

test("参数替换：引号参数保持整体", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates('/pr "两个 词"', [{ name: "pr", description: "", content: "[$1]" }]).message;
	assert.ok(out.includes("[两个 词]"));
});

test("无占位符的模板仍把用户输入追加在块后（PiDeck 的兜底，不丢字）", () => {
	const { expandPromptTemplates } = composerBehavior();
	const out = expandPromptTemplates("/commit 收尾", templates).message;
	assert.ok(out.includes("COMMIT-TEMPLATE-BODY"));
	assert.ok(out.trimEnd().endsWith("收尾"), `用户输入不能被丢，实际: ${JSON.stringify(out)}`);
});

test("参数不会跨过相邻命令 / 引用块", () => {
	const { expandPromptTemplates } = composerBehavior();
	const two = expandPromptTemplates("/pr 甲 /commit 乙", [
		{ name: "pr", description: "", content: "P:$1" },
		{ name: "commit", description: "", content: "C:$1" },
	]).message;
	assert.ok(two.includes("P:甲"), `pr 只吃自己的参数，实际: ${JSON.stringify(two)}`);
	assert.ok(two.includes("C:乙"), `commit 吃自己的参数，实际: ${JSON.stringify(two)}`);

	const quoted = expandPromptTemplates('/pr 甲 <quoted_context label="x" message_id="m1">\n引用\n</quoted_context>', [{ name: "pr", description: "", content: "P:$1" }]).message;
	assert.ok(quoted.includes("P:甲"), "参数不能跨进引用块");
	assert.ok(quoted.includes("<quoted_context"), "引用块必须原样保留");
});
