package main

// 会话条目表解析：TS `SessionHistoryReader.parseIndexLine` 的 Go 镜像（Wave 2）。
//
// 这里是本 sidecar 唯一「逐字段复刻 TS 语义」的地方，也是双实现漂移风险最高处：
// 字段名、可空性、"undefined 键不进 JSON" 的语义全部要与 TS 对齐，并由
// tests/sessionStoreIndexParity.test.mjs 用同一批 fixture 逐字段对照。
//
// 关键镜像细节（改 TS 侧必须同步改这里）：
//   - 可选字段用指针 + omitempty：TS 的可选属性是 undefined（JSON 序列化时消失），
//     而空字符串在 TS 里是**保留的键**，所以值类型 + omitempty 会误吞 "";
//   - hasMessage 只看**顶层** message 键是否存在且非 null，与 role 的来源（可下探
//     data.message / 顶层自身）不是同一处，这个不对称是 TS 既有语义，勿"顺手修正";
//   - customDisplay 只有 custom_message 才出现，且 display 缺失时为 false（真值）;
//   - assistantModel 要求 provider 与 model 都非空（TS 用真值判断）;
//   - context_edit 的 replacement === null 表示"移出上下文"，此时不取改写文本。

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// displayEntry 是 TS SessionDisplayEntry 的镜像。
type displayEntry struct {
	ID                  string          `json:"id"`
	ParentID            *string         `json:"parentId"`
	Type                string          `json:"type"`
	Offset              int64           `json:"offset"`
	ByteLength          int64           `json:"byteLength"`
	HasMessage          bool            `json:"hasMessage"`
	ModelChangeProvider *string         `json:"modelChangeProvider,omitempty"`
	ModelChangeID       *string         `json:"modelChangeId,omitempty"`
	AssistantModel      *assistantModel `json:"assistantModel,omitempty"`
	ThinkingLevel       *string         `json:"thinkingLevel,omitempty"`
	CustomType          *string         `json:"customType,omitempty"`
	CustomDisplay       *bool           `json:"customDisplay,omitempty"`
	Role                *string         `json:"role,omitempty"`
	ToolName            *string         `json:"toolName,omitempty"`
	MessageID           *string         `json:"messageId,omitempty"`
	MessageTimestamp    *float64        `json:"messageTimestamp,omitempty"`
	Oversized           *bool           `json:"oversized,omitempty"`
	Summary             *string         `json:"summary,omitempty"`
	FirstKeptEntryID    *string         `json:"firstKeptEntryId,omitempty"`
	Timestamp           *string         `json:"timestamp,omitempty"`
	TokensBefore        *float64        `json:"tokensBefore,omitempty"`
	ParentSession       *string         `json:"parentSession,omitempty"`
	ContextEditTargetID *string         `json:"contextEditTargetId,omitempty"`
	ContextEditExcludes *bool           `json:"contextEditExcludes,omitempty"`
	ContextEditText     *string         `json:"contextEditText,omitempty"`
	// Preview 用户消息首段文本（空白压成单空格，≤120 字），导轨/大纲直接用。
	//
	// 为什么在建索引时拿走：整行本来就要 JSON 解析（message.content 已在内存），
	// 事后再为了显示标题回读同一行是纯浪费；持久化进条目表后，未加载的历史
	// 也能显示真实提问文本（对齐 dsh session-turn-outline 的 prompt 预览口径）。
	Preview *string `json:"preview,omitempty"`
}

type assistantModel struct {
	Provider string `json:"provider"`
	ModelID  string `json:"modelId"`
}

type jsonObject map[string]json.RawMessage

func decodeObject(raw []byte) (jsonObject, bool) {
	var object jsonObject
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, false
	}
	return object, object != nil
}

func childObject(parent jsonObject, key string) jsonObject {
	raw, ok := parent[key]
	if !ok {
		return nil
	}
	object, ok := decodeObject(raw)
	if !ok {
		return nil
	}
	return object
}

func rawString(object jsonObject, key string) (string, bool) {
	if object == nil {
		return "", false
	}
	raw, ok := object[key]
	if !ok || isNullRaw(raw) {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func rawNumber(object jsonObject, key string) (float64, bool) {
	if object == nil {
		return 0, false
	}
	raw, ok := object[key]
	if !ok || isNullRaw(raw) {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

func rawTrue(object jsonObject, key string) bool {
	if object == nil {
		return false
	}
	raw, ok := object[key]
	if !ok {
		return false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	return value
}

func isNullRaw(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

func optionalString(value string) *string { return &value }

func optionalBool(value bool) *bool { return &value }

func optionalFloat(value float64) *float64 { return &value }

// parseTimestampMs 复刻 TS 的 Date.parse(timestamp)（毫秒）。
//
// 只认 pi 实际写出的 ISO-8601 形态；无法解析时返回 false，字段整体缺席
// （TS 侧此时是 NaN，两者都表示「拿不到可用时间戳」；改口径需同步改 parity 测试）。
func parseTimestampMs(value string) (float64, bool) {
	layouts := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05"}
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return float64(parsed.UnixNano()) / 1e6, true
		}
	}
	return 0, false
}

// parseIndexEntry 解析单行 JSONL；损坏行 / 缺 id 返回 false（TS 的 null）。
func parseIndexEntry(line string, offset int64, byteLength int64) (displayEntry, bool) {
	trimmed := strings.TrimSuffix(line, "\r")
	object, ok := decodeObject([]byte(trimmed))
	if !ok {
		return displayEntry{}, false
	}
	id, ok := rawString(object, "id")
	if !ok {
		return displayEntry{}, false
	}
	data := childObject(object, "data")
	// 与 TS 同序：parsed.message → data.message → （旧格式）整行自带 role
	message := childObject(object, "message")
	if message == nil {
		message = childObject(data, "message")
	}
	if message == nil {
		if _, isString := rawString(object, "role"); isString {
			message = object
		}
	}
	entryType, _ := rawString(object, "type")

	entry := displayEntry{ID: id, Type: entryType, Offset: offset, ByteLength: byteLength}
	if parentID, ok := rawString(object, "parentId"); ok {
		entry.ParentID = optionalString(parentID)
	}
	if raw, ok := object["message"]; ok && !isNullRaw(raw) {
		entry.HasMessage = true
	}
	if entryType == "context_edit" {
		if targetID, ok := rawString(object, "targetId"); ok {
			entry.ContextEditTargetID = optionalString(targetID)
		} else if targetID, ok := rawString(data, "targetId"); ok {
			entry.ContextEditTargetID = optionalString(targetID)
		}
		if raw, ok := object["replacement"]; ok && isNullRaw(raw) {
			entry.ContextEditExcludes = optionalBool(true)
		}
		if entry.ContextEditExcludes == nil {
			if replacement := childObject(object, "replacement"); replacement != nil {
				if content, ok := replacement["content"]; ok {
					if text, ok := decodeStringRaw(content); ok {
						entry.ContextEditText = optionalString(text)
					} else if text, ok := joinTextBlocks(content); ok {
						entry.ContextEditText = optionalString(text)
					}
				}
			}
		}
	}
	if entryType == "model_change" {
		if provider, ok := rawString(object, "provider"); ok {
			entry.ModelChangeProvider = optionalString(provider)
		} else if provider, ok := rawString(data, "provider"); ok {
			entry.ModelChangeProvider = optionalString(provider)
		}
		if modelID, ok := rawString(object, "modelId"); ok {
			entry.ModelChangeID = optionalString(modelID)
		} else if modelID, ok := rawString(data, "modelId"); ok {
			entry.ModelChangeID = optionalString(modelID)
		}
	}
	if entryType == "thinking_level_change" {
		if level, ok := rawString(object, "thinkingLevel"); ok {
			entry.ThinkingLevel = optionalString(level)
		} else if level, ok := rawString(data, "thinkingLevel"); ok {
			entry.ThinkingLevel = optionalString(level)
		}
	}
	isCustomMessage := entryType == "custom_message"
	if entryType == "custom" || isCustomMessage {
		if customType, ok := rawString(object, "customType"); ok {
			entry.CustomType = optionalString(customType)
		}
	}
	if isCustomMessage {
		entry.CustomDisplay = optionalBool(rawTrue(object, "display"))
	}
	if message != nil {
		if role, ok := rawString(message, "role"); ok {
			entry.Role = optionalString(role)
			if role == "assistant" {
				provider, hasProvider := rawString(message, "provider")
				modelID, hasModel := rawString(message, "model")
				if hasProvider && hasModel && provider != "" && modelID != "" {
					entry.AssistantModel = &assistantModel{Provider: provider, ModelID: modelID}
				}
			}
		}
		if toolName, ok := rawString(message, "toolName"); ok {
			entry.ToolName = optionalString(toolName)
		}
		if messageID, ok := rawString(message, "id"); ok {
			entry.MessageID = optionalString(messageID)
		}
		if timestamp, ok := rawNumber(message, "timestamp"); ok {
			entry.MessageTimestamp = optionalFloat(timestamp)
		} else if timestamp, ok := rawString(object, "timestamp"); ok {
			if ms, ok := parseTimestampMs(timestamp); ok {
				entry.MessageTimestamp = optionalFloat(ms)
			}
		}
		// 预览只取用户消息：助手/工具正文可能有几十 KB，导轨也用不到。
		if role, _ := rawString(message, "role"); role == "user" {
			if preview, ok := messagePreviewText(message); ok {
				entry.Preview = optionalString(preview)
			}
		}
	}
	if summary, ok := rawString(object, "summary"); ok {
		entry.Summary = optionalString(summary)
	}
	if firstKept, ok := rawString(object, "firstKeptEntryId"); ok {
		entry.FirstKeptEntryID = optionalString(firstKept)
	}
	if timestamp, ok := rawString(object, "timestamp"); ok {
		entry.Timestamp = optionalString(timestamp)
	}
	if tokens, ok := rawNumber(object, "tokensBefore"); ok {
		entry.TokensBefore = optionalFloat(tokens)
	}
	if entryType == "session" {
		if parentSession, ok := rawString(object, "parentSession"); ok {
			entry.ParentSession = optionalString(parentSession)
		}
	}
	return entry, true
}

func decodeStringRaw(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// previewMaxChars 与 TS `INDEX_PREVIEW_MAX_CHARS` 一致：导轨卡片一行够用。
const previewMaxChars = 120

// previewRefTags 预览要跳过的注入型引用块（用户看到的标题应是他自己打的字）。
// 与 TS `PREVIEW_REF_TAGS` 逐项对齐；顺序也一致（叠加多个块时影响剥离结果）。
var previewRefTags = []string{"quoted_context", "referenced_session", "skill", "prompt_template"}

// stripLeadingRefBlocks 跳过消息开头的注入引用块，返回用户真正输入的部分。
//
// 为什么必须先剥再截断：预览上限 120 字，引用块正文往往更长——先截断会把
// `<quoted_context ...>` 切成半截标签，导轨卡片就显示一坨 XML。
// 开头有引用块但找不到闭合标签时返回 ok=false：宁可不产预览，也不把半个标签当标题。
func stripLeadingRefBlocks(text string) (string, bool) {
	rest := text
	for {
		trimmed := strings.TrimLeftFunc(rest, unicode.IsSpace)
		matched := ""
		for _, tag := range previewRefTags {
			open := "<" + tag
			if !strings.HasPrefix(trimmed, open) || len(trimmed) == len(open) {
				continue
			}
			switch next := trimmed[len(open)]; next {
			case '>', ' ', '\t', '\n', '\r':
				matched = tag
			}
			if matched != "" {
				break
			}
		}
		if matched == "" {
			return trimmed, true
		}
		closeTag := "</" + matched + ">"
		index := strings.Index(strings.ToLower(trimmed), closeTag)
		if index < 0 {
			return "", false
		}
		rest = trimmed[index+len(closeTag):]
	}
}

// messagePreviewText 复刻 TS `indexPreviewOf`：message.content 为字符串或内容块数组时
// 取第一段非空文本，剥掉开头的引用块，空白压成单空格，按码点截断到 120 字。
//
// 与 TS 同步点（sessionStoreIndexParity 覆盖）：不校验 block.type（只看 text 是否非空）、
// 截断按完整码点（不切断代理对）、空文本或半个引用块视为没有预览。
func messagePreviewText(message jsonObject) (string, bool) {
	raw, ok := message["content"]
	if !ok {
		return "", false
	}
	text, hasText := decodeStringRaw(raw)
	if !hasText {
		var blocks []json.RawMessage
		if err := json.Unmarshal(raw, &blocks); err != nil {
			return "", false
		}
		for _, block := range blocks {
			object, ok := decodeObject(block)
			if !ok {
				continue
			}
			candidate, ok := rawString(object, "text")
			if !ok || strings.TrimSpace(candidate) == "" {
				continue
			}
			text = candidate
			hasText = true
			break
		}
	}
	if !hasText {
		return "", false
	}
	human, ok := stripLeadingRefBlocks(text)
	if !ok {
		return "", false
	}
	collapsed := collapseWhitespace(human)
	if collapsed == "" {
		return "", false
	}
	runes := []rune(collapsed)
	if len(runes) > previewMaxChars {
		collapsed = string(runes[:previewMaxChars])
	}
	return collapsed, true
}

// collapseWhitespace 把任意空白序列压成单个空格并去掉首尾（JS `\s+` 的等价物）。
func collapseWhitespace(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	pendingSpace := false
	for _, r := range text {
		if unicode.IsSpace(r) {
			pendingSpace = builder.Len() > 0
			continue
		}
		if pendingSpace {
			builder.WriteByte(' ')
			pendingSpace = false
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

// joinTextBlocks 复刻 TS contextEditTextOf：只取 type 为 text 的块的 text，按序拼接。
func joinTextBlocks(content json.RawMessage) (string, bool) {
	var blocks []json.RawMessage
	if err := json.Unmarshal(content, &blocks); err != nil {
		return "", false
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		object, ok := decodeObject(block)
		if !ok {
			continue
		}
		blockType, _ := rawString(object, "type")
		text, hasText := rawString(object, "text")
		if blockType == "text" && hasText {
			parts = append(parts, text)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, ""), true
}

var (
	oversizedIDPattern       = regexp.MustCompile(`"id"\s*:\s*"([^"\\]{1,64})"`)
	oversizedParentIDPattern = regexp.MustCompile(`"parentId"\s*:\s*"([^"\\]{1,64})"`)
	oversizedTypePattern     = regexp.MustCompile(`"type"\s*:\s*"([^"\\]{1,32})"`)
)

// parseOversizedEntry 复刻 TS parseOversizedIndexLine：超长行不解析正文，
// 只从行首前缀抢 id/parentId/type 以维持 parentId 链。
func parseOversizedEntry(prefix string, offset int64, byteLength int64) (displayEntry, bool) {
	idMatch := oversizedIDPattern.FindStringSubmatch(prefix)
	if len(idMatch) < 2 {
		return displayEntry{}, false
	}
	entry := displayEntry{ID: idMatch[1], Offset: offset, ByteLength: byteLength, Oversized: optionalBool(true)}
	if parentID := oversizedParentIDPattern.FindStringSubmatch(prefix); len(parentID) >= 2 {
		entry.ParentID = optionalString(parentID[1])
	}
	if entryType := oversizedTypePattern.FindStringSubmatch(prefix); len(entryType) >= 2 {
		entry.Type = entryType[1]
	}
	return entry, true
}

// table 是一个会话文件的条目表（等价于 TS 的 Map + lastEntryId + endsWithNewline）。
type table struct {
	Path            string         `json:"path"`
	Size            int64          `json:"size"`
	MtimeMs         float64        `json:"mtimeMs"`
	EndsWithNewline bool           `json:"endsWithNewline"`
	LastEntryID     string         `json:"lastEntryId,omitempty"`
	Entries         []displayEntry `json:"entries"`
	OversizedLines  int            `json:"oversizedLines"`
}

// appendLineSegment 把一段行内字节并入当前行缓冲；超过 64MiB 时降级为「只留前缀」。
func appendLineSegment(pending *[]byte, oversize *bool, segment []byte) {
	if *oversize {
		return
	}
	*pending = append(*pending, segment...)
	if int64(len(*pending)) <= maxScanLineBytes {
		return
	}
	prefix := *pending
	if len(prefix) > oversizedPrefixBytes {
		prefix = prefix[:oversizedPrefixBytes]
	}
	kept := make([]byte, len(prefix))
	copy(kept, prefix)
	*pending = kept
	*oversize = true
}

// scanTable 全量扫描并解析一个会话文件。
//
// 与 scanRange（store.go 的快照记账）同一套边界口径，但这里要产出**条目**，
// 所以整行必须留在内存里解析；单行超过 maxScanLineBytes 时按超长行降级。
func scanTable(path string, size int64, mtimeMs float64) (table, error) {
	return scanTableFrom(path, size, mtimeMs, 0, nil, "", 0)
}

// scanTableFrom 从 start 字节处接着扫描，把新条目追加到 entries。
//
// 只用于「上次扫描以换行结尾、文件只变长」的追加场景（持久化条目表的增量路径）：
// start 必须落在完整行边界，否则残行会被当成整行固化。调用方负责守这个前提。
func scanTableFrom(path string, size int64, mtimeMs float64, start int64, entries []displayEntry, lastEntryID string, oversizedLines int) (table, error) {
	handle, err := os.Open(path)
	if err != nil {
		return table{}, err
	}
	defer handle.Close()
	if start > 0 {
		if _, err := handle.Seek(start, io.SeekStart); err != nil {
			return table{}, err
		}
	}

	result := table{Path: path, Size: size, MtimeMs: mtimeMs, Entries: entries, LastEntryID: lastEntryID, OversizedLines: oversizedLines}
	buffer := make([]byte, scanChunkBytes)
	var scannedBytes int64
	pending := make([]byte, 0, 4096)
	var pendingBytes int64
	var offset int64 = start
	oversize := false

	// flushLine 结算一行；terminated = 该行以 \n 结尾（决定 offset 是否多推进一字节）
	flushLine := func(terminated bool) {
		if oversize {
			result.OversizedLines++
			if entry, ok := parseOversizedEntry(string(pending), offset, pendingBytes); ok {
				result.Entries = append(result.Entries, entry)
				result.LastEntryID = entry.ID
			}
		} else if entry, ok := parseIndexEntry(string(pending), offset, pendingBytes); ok {
			result.Entries = append(result.Entries, entry)
			result.LastEntryID = entry.ID
		}
		offset += pendingBytes
		if terminated {
			offset++
		}
		pendingBytes = 0
		oversize = false
		pending = pending[:0]
	}

	for {
		read, readErr := handle.Read(buffer)
		scannedBytes += int64(read)
		chunk := buffer[:read]
		for len(chunk) > 0 {
			newline := bytes.IndexByte(chunk, '\n')
			if newline < 0 {
				pendingBytes += int64(len(chunk))
				appendLineSegment(&pending, &oversize, chunk)
				break
			}
			pendingBytes += int64(newline)
			appendLineSegment(&pending, &oversize, chunk[:newline])
			flushLine(true)
			chunk = chunk[newline+1:]
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return table{}, readErr
		}
	}

	trailingBytes := pendingBytes
	if trailingBytes > 0 {
		// 末尾残行（pi 正在追加）：照常解析（历史要能看到），但宿主侧不得据此做增量追加
		flushLine(false)
	}
	// 与 jsonlLineStream 同口径：空文件（一个字节都没读到）不算以换行结尾
	result.EndsWithNewline = scannedBytes > 0 && trailingBytes == 0
	return result, nil
}
