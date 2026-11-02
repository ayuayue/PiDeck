import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 智能体图标编码回归（纯函数，无 JSX）：
 * 1) 历史数据只有 emoji 字符串，必须继续当文本渲染；
 * 2) 新的组件图标写成 `lucide:<id>`，解析后拿到 id，渲染层才映射到具体图标组件；
 * 3) 会话标题只在 emoji 形态下拼前缀——`lucide:bot` 拼进标题会露出编码。
 */
const { agentIconValueOfLucide, buildAgentSessionTitle, parseAgentIcon } = loadTsCommonJs("src/renderer/src/components/agents/agentIconCodec.ts");

test("emoji 图标按文本解析", () => {
	assert.deepEqual(plain(parseAgentIcon("🌐")), { kind: "text", text: "🌐" });
	// 历史数据里可能是多个字符的颜文字/符号，一律原样保留。
	assert.deepEqual(plain(parseAgentIcon("🧑‍💻")), { kind: "text", text: "🧑‍💻" });
	assert.deepEqual(plain(parseAgentIcon("  🚀  ")), { kind: "text", text: "🚀" });
});

test("空值与纯空白回退为空图标（渲染层换成机器人）", () => {
	for (const value of ["", "   ", undefined, null]) {
		assert.deepEqual(plain(parseAgentIcon(value)), { kind: "empty" });
	}
});

test("lucide 编码解析出组件 id", () => {
	assert.equal(parseAgentIcon("lucide:bot").kind, "lucide");
	assert.equal(parseAgentIcon("lucide:bot").id, "bot");
	assert.equal(parseAgentIcon(" lucide:graduation-cap ").id, "graduation-cap");
	// 前缀后没有 id：当作空图标，不要渲染成名为 lucide 的未知图标。
	assert.deepEqual(plain(parseAgentIcon("lucide:")), { kind: "empty" });
	// 大小写不敏感：用户/脚本手写的 `Lucide:Bot` 不该落到「未知图标」上。
	assert.equal(parseAgentIcon("Lucide:sparkles").kind, "lucide");
	assert.equal(parseAgentIcon("Lucide:sparkles").id, "sparkles");
});

test("组件图标 id 写成编码，且能原样读回", () => {
	assert.equal(agentIconValueOfLucide("bot"), "lucide:bot");
	const encoded = agentIconValueOfLucide("file-text");
	assert.deepEqual(plain(parseAgentIcon(encoded)), { kind: "lucide", id: "file-text" });
});

test("会话标题：emoji 拼前缀，组件图标不拼编码", () => {
	assert.equal(buildAgentSessionTitle({ name: "翻译助手", icon: "🌐" }), "🌐 翻译助手");
	assert.equal(buildAgentSessionTitle({ name: "代码审查", icon: "lucide:code" }), "代码审查");
	assert.equal(buildAgentSessionTitle({ name: "空图标", icon: "" }), "空图标");
	// 名称首尾空白仍要收我干净（标题来自用户输入）。
	assert.equal(buildAgentSessionTitle({ name: "  名字  ", icon: "lucide:bot" }), "名字");
});

/** TS 编译后的普通对象去掉原型差异，方便 deepEqual。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
