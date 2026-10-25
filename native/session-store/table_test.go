package main

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// table.go 的镜像语义测试：这里钉住的是"与 TS parseIndexLine 逐字段一致"的细节，
// 任何一处放宽都会让 Wave 2 的 parity 断言（tests/sessionStoreIndexParity.test.mjs）变红。

func mustParse(t *testing.T, line string) displayEntry {
	t.Helper()
	entry, ok := parseIndexEntry(line, 10, 20)
	if !ok {
		t.Fatalf("parseIndexEntry 应成功: %s", line)
	}
	return entry
}

func TestParseIndexEntryReadsNestedMessageFields(t *testing.T) {
	entry := mustParse(t, `{"id":"a1","parentId":"root","type":"message","message":{"role":"assistant","provider":"anthropic","model":"claude-3","toolName":"read","id":"m-1","timestamp":1735689600000}}`)
	if entry.ID != "a1" || entry.ParentID == nil || *entry.ParentID != "root" || entry.Type != "message" {
		t.Fatalf("基础字段错误: %+v", entry)
	}
	if entry.Offset != 10 || entry.ByteLength != 20 {
		t.Fatalf("offset/byteLength 应原样带出: %+v", entry)
	}
	if !entry.HasMessage {
		t.Fatal("hasMessage 应为 true（顶层 message 键存在）")
	}
	if entry.Role == nil || *entry.Role != "assistant" {
		t.Fatalf("role 应取自 message.role: %+v", entry.Role)
	}
	if entry.AssistantModel == nil || entry.AssistantModel.Provider != "anthropic" || entry.AssistantModel.ModelID != "claude-3" {
		t.Fatalf("assistantModel 错误: %+v", entry.AssistantModel)
	}
	if entry.ToolName == nil || *entry.ToolName != "read" {
		t.Fatalf("toolName 错误: %+v", entry.ToolName)
	}
	if entry.MessageID == nil || *entry.MessageID != "m-1" {
		t.Fatalf("messageId 错误: %+v", entry.MessageID)
	}
	if entry.MessageTimestamp == nil || *entry.MessageTimestamp != 1735689600000 {
		t.Fatalf("messageTimestamp 应取 message.timestamp 数字: %+v", entry.MessageTimestamp)
	}
}

// 顶层自带 role 的旧格式 + hasMessage 只看顶层 message 的不对称语义。
func TestParseIndexEntryTopLevelRoleHasNoMessageFlag(t *testing.T) {
	entry := mustParse(t, `{"id":"b1","type":"message","role":"user","content":[{"type":"text","text":"hi"}]}`)
	if entry.Role == nil || *entry.Role != "user" {
		t.Fatalf("role 应回退到顶层: %+v", entry.Role)
	}
	if entry.HasMessage {
		t.Fatal("没有顶层 message 键时 hasMessage 必须为 false（TS 既有语义）")
	}
	if entry.AssistantModel != nil {
		t.Fatal("role=user 不应产生 assistantModel")
	}
}

func TestParseIndexEntryDataFallbacks(t *testing.T) {
	entry := mustParse(t, `{"id":"m1","type":"model_change","data":{"provider":"openai","modelId":"gpt-5"}}`)
	if entry.ModelChangeProvider == nil || *entry.ModelChangeProvider != "openai" {
		t.Fatalf("modelChangeProvider 应下探 data: %+v", entry.ModelChangeProvider)
	}
	if entry.ModelChangeID == nil || *entry.ModelChangeID != "gpt-5" {
		t.Fatalf("modelChangeId 应下探 data: %+v", entry.ModelChangeID)
	}

	level := mustParse(t, `{"id":"t1","type":"thinking_level_change","data":{"thinkingLevel":"high"}}`)
	if level.ThinkingLevel == nil || *level.ThinkingLevel != "high" {
		t.Fatalf("thinkingLevel 应下探 data: %+v", level.ThinkingLevel)
	}

	message := mustParse(t, `{"id":"d1","type":"message","data":{"message":{"role":"user","toolName":"bash"}},"message":null}`)
	if message.Role == nil || *message.Role != "user" {
		t.Fatalf("message 缺失时应下探 data.message: %+v", message.Role)
	}
	if message.HasMessage {
		t.Fatal("顶层 message 为 null 时 hasMessage 必须为 false")
	}
}

func TestParseIndexEntryContextEditVariants(t *testing.T) {
	removed := mustParse(t, `{"id":"c1","type":"context_edit","targetId":"x1","replacement":null}`)
	if removed.ContextEditTargetID == nil || *removed.ContextEditTargetID != "x1" {
		t.Fatalf("contextEditTargetId 错误: %+v", removed.ContextEditTargetID)
	}
	if removed.ContextEditExcludes == nil || !*removed.ContextEditExcludes {
		t.Fatalf("replacement=null 应标记为移出上下文: %+v", removed.ContextEditExcludes)
	}
	if removed.ContextEditText != nil {
		t.Fatalf("移出上下文时不应带改写文本: %+v", *removed.ContextEditText)
	}

	text := mustParse(t, `{"id":"c2","type":"context_edit","data":{"targetId":"x2"},"replacement":{"content":"重写后的正文"}}`)
	if text.ContextEditTargetID == nil || *text.ContextEditTargetID != "x2" {
		t.Fatalf("targetId 应下探 data: %+v", text.ContextEditTargetID)
	}
	if text.ContextEditText == nil || *text.ContextEditText != "重写后的正文" {
		t.Fatalf("字符串 replacement.content 错误: %+v", text.ContextEditText)
	}
	if text.ContextEditExcludes != nil {
		t.Fatal("有 replacement 时不应有 excludes 标记")
	}

	blocks := mustParse(t, `{"id":"c3","type":"context_edit","targetId":"x3","replacement":{"content":[{"type":"text","text":"甲"},{"type":"image","data":"ignored"},{"type":"text","text":"乙"}]}}`)
	if blocks.ContextEditText == nil || *blocks.ContextEditText != "甲乙" {
		t.Fatalf("内容块应只拼 text 块: %+v", blocks.ContextEditText)
	}

	noText := mustParse(t, `{"id":"c4","type":"context_edit","targetId":"x4","replacement":{"content":[{"type":"image","data":"x"}]}}`)
	if noText.ContextEditText != nil {
		t.Fatalf("没有 text 块时应缺席（调用方回退原文）: %+v", *noText.ContextEditText)
	}
}

func TestParseIndexEntryCustomAndSessionEntries(t *testing.T) {
	custom := mustParse(t, `{"id":"k1","type":"custom","customType":"pi-deck-todo"}`)
	if custom.CustomType == nil || *custom.CustomType != "pi-deck-todo" {
		t.Fatalf("custom.customType 错误: %+v", custom.CustomType)
	}
	if custom.CustomDisplay != nil {
		t.Fatal("非 custom_message 不应有 customDisplay")
	}

	hidden := mustParse(t, `{"id":"k2","type":"custom_message","customType":"subagents:record"}`)
	if hidden.CustomDisplay == nil || *hidden.CustomDisplay {
		t.Fatalf("display 缺失时应为 false: %+v", hidden.CustomDisplay)
	}

	shown := mustParse(t, `{"id":"k3","type":"custom_message","display":true}`)
	if shown.CustomDisplay == nil || !*shown.CustomDisplay {
		t.Fatalf("display:true 应透传: %+v", shown.CustomDisplay)
	}

	head := mustParse(t, `{"id":"s1","type":"session","parentSession":"/root/ancestor.jsonl","summary":"摘要","firstKeptEntryId":"f1","tokensBefore":123,"timestamp":"2026-02-01T00:00:00.000Z"}`)
	if head.ParentSession == nil || *head.ParentSession != "/root/ancestor.jsonl" {
		t.Fatalf("session.parentSession 错误: %+v", head.ParentSession)
	}
	if head.Summary == nil || *head.Summary != "摘要" || head.FirstKeptEntryID == nil || head.TokensBefore == nil || *head.TokensBefore != 123 {
		t.Fatalf("批次头字段错误: %+v", head)
	}
	if head.Timestamp == nil || *head.Timestamp != "2026-02-01T00:00:00.000Z" {
		t.Fatalf("timestamp 应原样保留字符串: %+v", head.Timestamp)
	}
	// 顶层 timestamp 是字符串且 message 无数字时间戳时，messageTimestamp 取其解析值
	if head.MessageTimestamp != nil {
		t.Fatalf("无 message 时不应有 messageTimestamp: %+v", head.MessageTimestamp)
	}
}

func TestParseIndexEntryFallsBackToTimestampString(t *testing.T) {
	entry := mustParse(t, `{"id":"a1","type":"message","timestamp":"2026-02-01T00:00:00.000Z","message":{"role":"user"}}`)
	if entry.MessageTimestamp == nil || *entry.MessageTimestamp != 1769904000000 {
		t.Fatalf("应回退解析顶层 timestamp: %+v", entry.MessageTimestamp)
	}
}

func TestParseIndexEntryRejectsBrokenLines(t *testing.T) {
	for _, line := range []string{"", "   ", "{", `{"type":"message"}`, `{"id":42}`, `not json`} {
		if entry, ok := parseIndexEntry(line, 0, 0); ok {
			t.Fatalf("非法行应被跳过，得到 %+v（输入 %q）", entry, line)
		}
	}
}

func TestParseIndexEntryAcceptsEmptyOptionalStrings(t *testing.T) {
	// TS 对空字符串是"保留键"，所以这里必须出现空字符串而不是缺席（parity 敏感点）
	entry := mustParse(t, `{"id":"e1","type":"","message":{"role":""}}`)
	payload, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal 失败: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal 失败: %v", err)
	}
	if value, ok := decoded["role"]; !ok || value != "" {
		t.Fatalf("空 role 应保留为 \"\": %s", string(payload))
	}
	if _, ok := decoded["toolName"]; ok {
		t.Fatalf("缺席字段不应出现: %s", string(payload))
	}
}

func TestParseIndexEntryDropsUnresolvableModelPairs(t *testing.T) {
	entry := mustParse(t, `{"id":"a1","type":"message","message":{"role":"assistant","provider":"openai"}}`)
	if entry.AssistantModel != nil {
		t.Fatalf("缺 model 时不应有 assistantModel: %+v", entry.AssistantModel)
	}
	empty := mustParse(t, `{"id":"a2","type":"message","message":{"role":"assistant","provider":"","model":"gpt-5"}}`)
	if empty.AssistantModel != nil {
		t.Fatalf("空 provider 不应有 assistantModel: %+v", empty.AssistantModel)
	}
}

func TestParseOversizedEntryKeepsChain(t *testing.T) {
	prefix := `{"id":"big-1","parentId":"parent-9","type":"message","message":{"content":[{"type":"image"`
	entry, ok := parseOversizedEntry(prefix, 5, 99)
	if !ok {
		t.Fatal("前缀含 id 时应能降级")
	}
	if entry.ID != "big-1" || entry.ParentID == nil || *entry.ParentID != "parent-9" || entry.Type != "message" {
		t.Fatalf("降级条目字段错误: %+v", entry)
	}
	if entry.Oversized == nil || !*entry.Oversized {
		t.Fatal("降级条目应带 oversized 标记")
	}
	if entry.HasMessage {
		t.Fatal("降级条目没有正文，hasMessage 必须为 false")
	}
	if _, ok := parseOversizedEntry(`{"parentId":"p","type":"message"}`, 0, 0); ok {
		t.Fatal("前缀没有 id 时不应产生条目（保持链完整的前提是 id）")
	}
}

func TestAppendLineSegmentDegradesPastLimit(t *testing.T) {
	pending := make([]byte, 0, 8)
	oversize := false
	appendLineSegment(&pending, &oversize, []byte("head"))
	if oversize {
		t.Fatal("正常长度不应降级")
	}
	// 单行超过 64MiB（maxScanLineBytes）才降级：只保留 oversizedPrefixBytes 前缀
	appendLineSegment(&pending, &oversize, []byte(strings.Repeat("x", maxScanLineBytes)))
	if !oversize {
		t.Fatal("超过单行上限后应标记降级")
	}
	if len(pending) != oversizedPrefixBytes {
		t.Fatalf("降级后应只保留 %d 字节前缀，实际 %d", oversizedPrefixBytes, len(pending))
	}
	// 降级后继续喂数据不得再增长（避免超长行撑爆内存）
	appendLineSegment(&pending, &oversize, []byte(strings.Repeat("y", 4096)))
	if len(pending) != oversizedPrefixBytes {
		t.Fatalf("降级后不应继续累积: %d", len(pending))
	}
}

func TestScanTableTracksOffsetsAndTrailingLine(t *testing.T) {
	fixture := newFixture(t)
	fixture.write("sessions/a.jsonl", `{"id":"s1","type":"session"}`+"\n"+`{"id":"a1","parentId":"s1","type":"message","message":{"role":"user"}}`+"\n"+`{"id":"a2","parentId":"a1","type":"message","message":{"role":"assistant"}}`+"\n")

	result, err := scanTable(fixture.path("sessions/a.jsonl"), 0, 0)
	if err != nil {
		t.Fatalf("scanTable 失败: %v", err)
	}
	if len(result.Entries) != 3 || result.LastEntryID != "a2" {
		t.Fatalf("条目数/lastEntryId 错误: %d %s", len(result.Entries), result.LastEntryID)
	}
	if !result.EndsWithNewline {
		t.Fatal("以换行结尾时 endsWithNewline 应为 true")
	}
	firstLine := `{"id":"s1","type":"session"}`
	if result.Entries[0].Offset != 0 || result.Entries[0].ByteLength != int64(len(firstLine)) {
		t.Fatalf("首行 offset/byteLength 错误: %+v", result.Entries[0])
	}
	secondOffset := int64(len(firstLine)) + 1
	if result.Entries[1].Offset != secondOffset {
		t.Fatalf("第二行 offset 应为 %d，实际 %d", secondOffset, result.Entries[1].Offset)
	}
}

// 末尾残行：pi 正在追加时必须解析出来（历史要能看到），但 endsWithNewline=false。
func TestScanTableParsesTrailingPartialLine(t *testing.T) {
	fixture := newFixture(t)
	fixture.write("sessions/b.jsonl", `{"id":"s1","type":"session"}`+"\n"+`{"id":"a1","parentId":"s1","type":"message"`)

	result, err := scanTable(fixture.path("sessions/b.jsonl"), 0, 0)
	if err != nil {
		t.Fatalf("scanTable 失败: %v", err)
	}
	if result.EndsWithNewline {
		t.Fatal("残行结尾时 endsWithNewline 必须为 false")
	}
	if len(result.Entries) != 1 || result.LastEntryID != "s1" {
		t.Fatalf("残行不应产出条目: %d %s", len(result.Entries), result.LastEntryID)
	}
}

func TestScanTableHandlesCarriageReturnsAndEmptyLines(t *testing.T) {
	fixture := newFixture(t)
	fixture.write("sessions/c.jsonl", `{"id":"s1","type":"session"}`+"\r\n"+"\n"+`{"id":"a1","parentId":"s1","type":"message","message":{"role":"user"}}`)

	result, err := scanTable(fixture.path("sessions/c.jsonl"), 0, 0)
	if err != nil {
		t.Fatalf("scanTable 失败: %v", err)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("空行不应产出条目: %d", len(result.Entries))
	}
	// byteLength 含 \r（与 jsonlLineStream 同口径：行字节数不含 \n、含 \r）
	crlfLength := int64(len(`{"id":"s1","type":"session"}`) + 1)
	if result.Entries[0].ByteLength != crlfLength {
		t.Fatalf("CRLF 行 byteLength 应为 %d，实际 %d", crlfLength, result.Entries[0].ByteLength)
	}
	thirdOffset := crlfLength + 1 + 1
	if result.Entries[1].Offset != thirdOffset {
		t.Fatalf("空行后的 offset 错误: %d", result.Entries[1].Offset)
	}
}

func TestScanTableEmptyFileHasNoTrailingNewline(t *testing.T) {
	fixture := newFixture(t)
	fixture.write("sessions/empty.jsonl", "")

	result, err := scanTable(fixture.path("sessions/empty.jsonl"), 0, 0)
	if err != nil {
		t.Fatalf("scanTable 失败: %v", err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("空文件不应有条目: %d", len(result.Entries))
	}
	if result.EndsWithNewline {
		t.Fatal("空文件与 jsonlLineStream 同口径：endsWithNewline 必须为 false")
	}
}

func TestTableCacheHitAndVersionChange(t *testing.T) {
	cache := newTableCache("")
	cache.put(table{Path: "/a.jsonl", Size: 10, MtimeMs: 1.5, Entries: make([]displayEntry, 3)})
	if _, ok := cache.get("/a.jsonl", 10, 1.5); !ok {
		t.Fatal("版本一致应命中")
	}
	if _, ok := cache.get("/a.jsonl", 11, 1.5); ok {
		t.Fatal("size 变化不应命中")
	}
	if _, ok := cache.get("/a.jsonl", 10, 2.5); ok {
		t.Fatal("mtimeMs 变化不应命中")
	}
	hits, misses, _ := cache.statsSnapshot()
	if hits != 1 || misses != 2 {
		t.Fatalf("命中/未命中统计错误: hit=%d miss=%d", hits, misses)
	}
}

func TestTableCacheEvictsLeastRecentlyUsed(t *testing.T) {
	cache := newTableCache("")
	for index := 0; index < maxCachedTables; index++ {
		path := "/session-" + strings.Repeat("x", index%7+1) + string(rune('a'+index)) + ".jsonl"
		cache.put(table{Path: path, Size: 1, MtimeMs: 1, Entries: make([]displayEntry, 1)})
	}
	// 访问第 0 个使其变为最新，再写入一个新表触发淘汰
	firstPath := "/session-" + strings.Repeat("x", 1) + "a.jsonl"
	if _, ok := cache.get(firstPath, 1, 1); !ok {
		t.Fatalf("首个表应仍在缓存: %s", firstPath)
	}
	cache.put(table{Path: "/newest.jsonl", Size: 1, MtimeMs: 1, Entries: make([]displayEntry, 1)})
	if _, ok := cache.get(firstPath, 1, 1); !ok {
		t.Fatal("最近访问过的表不应被淘汰")
	}
	if _, hit := cache.get("/session-"+strings.Repeat("x", 2)+"b.jsonl", 1, 1); hit {
		t.Fatal("最久未访问的表应被淘汰")
	}
	_, _, evicted := cache.statsSnapshot()
	if evicted == 0 {
		t.Fatal("应记录淘汰次数")
	}
}

// preview：用户消息首段文本在建索引时带走（导轨标题不靠回读正文）。
func TestParseIndexEntryPreview(t *testing.T) {
	cases := []struct {
		name     string
		line     string
		expected string
	}{
		{"字符串 content", `{"id":"u1","type":"message","message":{"role":"user","content":"你好  世界"}}`, "你好 世界"},
		{"内容块数组取首段文本", `{"id":"u2","type":"message","message":{"role":"user","content":[{"type":"image"},{"type":"text","text":"第一条"},{"type":"text","text":"第二条"}]}}`, "第一条"},
		{"空白压成单空格并去首尾", `{"id":"u3","type":"message","message":{"role":"user","content":"  第一行\n\n  第二行  "}}`, "第一行 第二行"},
	}
	for _, testCase := range cases {
		entry := mustParse(t, testCase.line)
		if entry.Preview == nil {
			t.Fatalf("%s：应产出 preview", testCase.name)
		}
		if *entry.Preview != testCase.expected {
			t.Fatalf("%s：preview=%q，期望 %q", testCase.name, *entry.Preview, testCase.expected)
		}
	}
}

func TestParseIndexEntryPreviewScope(t *testing.T) {
	// 助手/工具消息不产 preview（正文可能几十 KB，导轨用不到）。
	assistant := mustParse(t, `{"id":"a1","type":"message","message":{"role":"assistant","content":"回答正文"}}`)
	if assistant.Preview != nil {
		t.Fatalf("assistant 不应有 preview: %q", *assistant.Preview)
	}
	// 空文本与纯图片不产 preview（避免导轨出现空标题）。
	empty := mustParse(t, `{"id":"u1","type":"message","message":{"role":"user","content":"   "}}`)
	if empty.Preview != nil {
		t.Fatalf("空白 content 不应有 preview: %q", *empty.Preview)
	}
	imageOnly := mustParse(t, `{"id":"u2","type":"message","message":{"role":"user","content":[{"type":"image"}]}}`)
	if imageOnly.Preview != nil {
		t.Fatalf("纯图片不应有 preview: %q", *imageOnly.Preview)
	}
}

func TestMessagePreviewTextTruncatesByRune(t *testing.T) {
	// 按完整码点截断：emoji 不能被切成半个代理对（Go 侧按 rune，等价于 TS 的码点切片）。
	message := jsonObject{"content": json.RawMessage(`"` + strings.Repeat("😀", 200) + `"`)}
	preview, ok := messagePreviewText(message)
	if !ok {
		t.Fatal("应产出 preview")
	}
	if runes := []rune(preview); len(runes) != previewMaxChars {
		t.Fatalf("截断后应为 %d 个码点，实际 %d", previewMaxChars, len(runes))
	}
	if !utf8.ValidString(preview) {
		t.Fatal("截断不能产生非法 UTF-8（半个 emoji）")
	}
}

func TestPreviewSkipsLeadingRefBlocks(t *testing.T) {
	// 开头的注入引用块必须剥掉：否则先按 120 字截断会把 <quoted_context ...> 切半，
	// 导轨卡片显示半截 XML（真实数据里很常见：用户引用上下文再提问）。
	entry := mustParse(t, `{"id":"u1","type":"message","message":{"role":"user","content":[{"type":"text","text":"<quoted_context label=\"模型：打开远端项目\" message_id=\"db59\">\n引用正文\n</quoted_context>\n真正的问题在这里"}]}}`)
	if entry.Preview == nil || *entry.Preview != "真正的问题在这里" {
		t.Fatalf("应剥掉引用块只留提问，实际 %v", entry.Preview)
	}
	// 多个引用块叠加也要剥干净。
	stacked := mustParse(t, `{"id":"u2","type":"message","message":{"role":"user","content":"<skill name=\"a\">\n用法\n</skill>\n<referenced_session name=\"b\">\n内容\n</referenced_session>\n最终提问"}}`)
	if stacked.Preview == nil || *stacked.Preview != "最终提问" {
		t.Fatalf("叠加引用块应全部剥掉，实际 %v", stacked.Preview)
	}
	// 未闭合的引用块不产预览（宁缺勿脏）。
	broken := mustParse(t, `{"id":"u3","type":"message","message":{"role":"user","content":"<quoted_context label=\"x\" message_id=\"y\">\n未闭合"}}`)
	if broken.Preview != nil {
		t.Fatalf("未闭合引用块不应有 preview: %q", *broken.Preview)
	}
}
