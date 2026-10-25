// 会话历史/气泡只应显示用户原话：宿主注入的通道指令（微信、飞书）曾是消息正文的一部分，
// 历史里直接展示会变成「每一条消息前面都挂一段提示词」。这些用例钉住展示层的剥离口径。
import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const sandbox = createTsSandbox({});
const { extractMessageText } = sandbox("src/main/pi/messageContent.ts");
const { stripHostInstruction, wrapHostInstruction } = sandbox("src/main/feishu/docActions.ts");

// 与 WeChatBridge.buildAgentMessage 的第一行完全一致（带通道签名，剥离判据依赖它）。
const WECHAT_INSTRUCTION = [
	"当前会话已连接微信（iLink 私聊通道）。微信只支持纯文本：不要输出 Markdown 表格、代码围栏、图片或链接语法，表格请改成分行列表，PiDeck 会在回复前做纯文本降级。",
	"不要调用任何微信/IM 发送接口、CLI 或工具来发消息，也不要询问 chat_id：你的最终回答会自动回复给微信用户。",
	"该通道不支持发送文件、图片与引用消息；需要用户手动取用文件时，直接给出绝对路径。",
	"微信通道不能主动推送消息，用户只有发消息时才能收到回复。",
	"请用中文回答。",
].join("\n");

test("历史里的微信宿主指令被剥掉，只留用户原文", () => {
	assert.equal(stripHostInstruction(`${WECHAT_INSTRUCTION}\n\n今天天气怎么样`), "今天天气怎么样");
	assert.equal(extractMessageText(`${WECHAT_INSTRUCTION}\n\n今天天气怎么样`), "今天天气怎么样");
});

test("单换行拼接（用户原文为空或旧格式）也能剥离", () => {
	assert.equal(extractMessageText(`${WECHAT_INSTRUCTION}\n你好`), "你好");
	assert.equal(extractMessageText(WECHAT_INSTRUCTION), "");
});

test("只保留用户原文里的空行与格式", () => {
	const message = `${WECHAT_INSTRUCTION}\n\n第一段\n\n第二段\n- 列表项`;
	assert.equal(extractMessageText(message), "第一段\n\n第二段\n- 列表项");
});

test("带标记的新格式按边界剥离", () => {
	assert.equal(extractMessageText(wrapHostInstruction("内部指令", "正文")), "正文");
	assert.equal(extractMessageText("[PIDECK_HOST_INSTRUCTION]\n内部指令\n[/PIDECK_HOST_INSTRUCTION]\n\n正文"), "正文");
});

test("飞书历史指令的剥离不能回归", () => {
	const feishu = "当前会话已连接飞书聊天。严禁调用 lark-cli、飞书 IM API 或搜索群聊来发送文件；不要询问 chat_id。\n当前绑定的飞书 chat_id: oc_xxx\n\n帮我整理一份周报";
	assert.equal(extractMessageText(feishu), "帮我整理一份周报");
});

test("普通用户消息不被动（只有真正带通道签名才剥）", () => {
	assert.equal(extractMessageText("当前会话已连接微信吗？"), "当前会话已连接微信吗？");
	assert.equal(extractMessageText("微信只支持纯文本吗？"), "微信只支持纯文本吗？");
});

test("自动标题里的宿主指令同样被剥掉（侧栏不能出现整段提示词）", () => {
	const { sanitizeAutomaticTitle } = sandbox("src/main/sessions/sessionTitleSanitize.ts");
	assert.equal(sanitizeAutomaticTitle(`${WECHAT_INSTRUCTION}\n\n1`), "1");
	assert.equal(sanitizeAutomaticTitle(`${WECHAT_INSTRUCTION}\n\n帮我看看这个 bug`), "帮我看看这个 bug");
	// 整条消息只有指令（用户只发了空内容）时没标题可用，调用方应忽略空串
	assert.equal(sanitizeAutomaticTitle(WECHAT_INSTRUCTION), "");
	// 正常标题/多行标题只做空白归一，不被误伤
	assert.equal(sanitizeAutomaticTitle("修复登录超时\n第二行"), "修复登录超时 第二行");
	assert.equal(sanitizeAutomaticTitle("  多余空格  "), "多余空格");
});
