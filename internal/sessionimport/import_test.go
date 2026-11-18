//go:build !js && !android && !ios

package sessionimport

// Checks for importing other agents' sessions: what each source's file
// becomes in pi's terms, and that a second import of the same session is a
// no-op while a changed one is read again.

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestImportClaudeKeepsTheLiveChain imports a transcript that was rewound:
// the abandoned branch must not come along, and the turn it replaced must.
func TestImportClaudeKeepsTheLiveChain(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"user","sessionId":"c1","cwd":"C:/work/app","uuid":"u1","parentUuid":null,"timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"第一问"}}`,
		`{"type":"assistant","sessionId":"c1","cwd":"C:/work/app","uuid":"a1","parentUuid":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"第一答"}],"stop_reason":"end_turn"}}`,
		`{"type":"user","sessionId":"c1","cwd":"C:/work/app","uuid":"u2","parentUuid":"a1","timestamp":"2026-06-01T10:00:02Z","message":{"role":"user","content":"旧分支的问题"}}`,
		`{"type":"assistant","sessionId":"c1","cwd":"C:/work/app","uuid":"a2old","parentUuid":"u2","timestamp":"2026-06-01T10:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"旧分支的回答"}]}}`,
		`{"type":"user","sessionId":"c1","cwd":"C:/work/app","uuid":"u3","parentUuid":"a1","timestamp":"2026-06-01T10:00:04Z","message":{"role":"user","content":"换一种问法"}}`,
		`{"type":"assistant","sessionId":"c1","cwd":"C:/work/app","uuid":"a2","parentUuid":"u3","timestamp":"2026-06-01T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"新的回答"}]}}`,
	}, "\n") + "\n"
	meta := importFixture(t, Claude, dir, "c1.jsonl", body, "")
	text := importText(t, meta.File)
	for _, want := range []string{"第一问", "第一答", "换一种问法", "新的回答"} {
		if !strings.Contains(text, want) {
			t.Errorf("imported session lacks %q:\n%s", want, text)
		}
	}
	for _, gone := range []string{"旧分支的问题", "旧分支的回答"} {
		if strings.Contains(text, gone) {
			t.Errorf("the abandoned branch came along: %q\n%s", gone, text)
		}
	}
	if filepath.Clean(meta.Cwd) != filepath.Clean("C:/work/app") {
		t.Fatalf("cwd = %q", meta.Cwd)
	}
}

// TestImportClaudePairsTools checks the content mapping: tool calls and
// their results, an orphan result kept as text, and consecutive assistant
// entries merged into one turn.
func TestImportClaudePairsTools(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"user","sessionId":"c2","cwd":"C:/work/app","uuid":"u1","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"看看构建"}}`,
		`{"type":"assistant","sessionId":"c2","cwd":"C:/work/app","uuid":"a1","parentUuid":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先读文件"},{"type":"tool_use","id":"t1","name":"read","input":{"path":"build.sh"}}],"stop_reason":"tool_use"}}`,
		`{"type":"user","sessionId":"c2","cwd":"C:/work/app","uuid":"u2","parentUuid":"a1","timestamp":"2026-06-01T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"echo hi"}]}]}}`,
		`{"type":"user","sessionId":"c2","cwd":"C:/work/app","uuid":"u3","parentUuid":"u2","timestamp":"2026-06-01T10:00:03Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"gone","content":"失联的结果"},{"type":"text","text":"继续"}]}}`,
		`{"type":"assistant","sessionId":"c2","cwd":"C:/work/app","uuid":"a2","parentUuid":"u3","timestamp":"2026-06-01T10:00:04Z","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
		`{"type":"assistant","sessionId":"c2","cwd":"C:/work/app","uuid":"a3","parentUuid":"a2","timestamp":"2026-06-01T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"继续说"}]}}`,
		`{"type":"file-history-snapshot","sessionId":"c2","timestamp":"2026-06-01T10:00:06Z"}`,
	}, "\n") + "\n"
	meta := importFixture(t, Claude, dir, "c2.jsonl", body, "")
	text := importText(t, meta.File)
	for _, want := range []string{`"type":"toolCall"`, `"name":"read"`, `"role":"toolResult"`, `"toolCallId":"t1"`,
		"失联的结果", "detached from its tool call", "继续说"} {
		if !strings.Contains(text, want) {
			t.Errorf("imported session lacks %q:\n%s", want, text)
		}
	}
	// Two assistant turns: one answered the tool call, and the two entries
	// after it were merged into one message.
	if got := strings.Count(text, "\"role\":\"assistant\""); got != 2 {
		t.Errorf("assistant messages = %d, want 2\n%s", got, text)
	}
	if strings.Contains(text, "file-history-snapshot") {
		t.Error("a file history snapshot was imported")
	}
}

// TestImportCodex converts a rollout: the cwd and id come from the header,
// developer messages are dropped, and a command and its output pair up.
func TestImportCodex(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"timestamp":"2026-06-01T10:00:00Z","type":"session_meta","payload":{"id":"c1","cwd":"C:/work/x"}}`,
		`{"timestamp":"2026-06-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"skip me"}]}}`,
		`{"timestamp":"2026-06-01T10:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好 Codex"}]}}`,
		`{"timestamp":"2026-06-01T10:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}","call_id":"call-1"}}`,
		`{"timestamp":"2026-06-01T10:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"a.txt"}}`,
		`{"timestamp":"2026-06-01T10:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好，我在。"}]}}`,
	}, "\n") + "\n"
	meta := importFixture(t, Codex, dir, "rollout.jsonl", body, "")
	text := importText(t, meta.File)
	for _, want := range []string{"你好 Codex", "你好，我在。", `"name":"shell"`, `"toolCallId":"call-1"`, "a.txt"} {
		if !strings.Contains(text, want) {
			t.Errorf("imported session lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "skip me") {
		t.Error("a developer message was imported")
	}
	if !strings.HasPrefix(meta.Title, "Codex CLI · ") {
		t.Fatalf("title = %q", meta.Title)
	}
}

// TestImportCodexMergesAndDropsScaffolding checks the shape Codex needs:
// its own context messages are not the user's words, a reasoning line and
// consecutive assistant entries become one turn, and a result with no call
// is kept as text.
func TestImportCodexMergesAndDropsScaffolding(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"timestamp":"2026-06-01T10:00:00Z","type":"session_meta","payload":{"id":"c7","cwd":"C:/work/s"}}`,
		`{"timestamp":"2026-06-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>ignore"}]}}`,
		`{"timestamp":"2026-06-01T10:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for C:/work/s"},{"type":"input_text","text":"<environment_context>cwd here</environment_context>"}]}}`,
		`{"timestamp":"2026-06-01T10:00:03Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"## My request: 请修一下构建"}]}}`,
		`{"timestamp":"2026-06-01T10:00:04Z","type":"response_item","payload":{"type":"reasoning","summary":[{"text":"先想一下"}]}}`,
		`{"timestamp":"2026-06-01T10:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"先看日志"}]}}`,
		`{"timestamp":"2026-06-01T10:00:06Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"go build\"}","call_id":"call-7"}}`,
		`{"timestamp":"2026-06-01T10:00:07Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-7","output":"build failed"}}`,
		`{"timestamp":"2026-06-01T10:00:08Z","type":"response_item","payload":{"type":"function_call_output","call_id":"gone","output":"失联输出"}}`,
	}, "\n") + "\n"
	meta := importFixture(t, Codex, dir, "rollout-c7.jsonl", body, "")
	text := importText(t, meta.File)
	if strings.Contains(text, "environment_context") || strings.Contains(text, "AGENTS.md") {
		t.Errorf("Codex's own context was imported as the user's words:\n%s", text)
	}
	for _, want := range []string{"请修一下构建", "先想一下", "先看日志", `"toolCallId":"call-7"`, "build failed", "失联输出"} {
		if !strings.Contains(text, want) {
			t.Errorf("imported session lacks %q:\n%s", want, text)
		}
	}
	// The reasoning line and the assistant text around one tool call are a
	// single turn.
	if got := strings.Count(text, `"role":"assistant"`); got != 1 {
		t.Errorf("assistant messages = %d, want 1 merged turn:\n%s", got, text)
	}
	if !strings.HasPrefix(meta.Title, "Codex CLI · ") || !strings.Contains(meta.Title, "请修一下构建") {
		t.Fatalf("title = %q", meta.Title)
	}
}

// TestImportKimiSkipsTheSecondWriting checks the dedupe Kimi Code needs: a
// message is written twice, and only one copy may be imported.
func TestImportKimiSkipsTheSecondWriting(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"context.append_message","message":{"id":"m1","role":"user","content":[{"type":"text","text":"帮我看下测试"}]}}`,
		`{"type":"agent.message.appended","message":{"message":{"id":"m1","role":"user","content":[{"type":"text","text":"帮我看下测试"}]},"meta":{}}}`,
		`{"type":"agent.message.appended","message":{"message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"好"}]},"meta":{"finish":{"finishReason":"stop"},"usage":{"inputOther":11,"output":7,"inputCacheRead":5,"inputCacheCreation":3}}}}`,
	}, "\n") + "\n"
	meta := importFixture(t, Kimi, dir, "wire.jsonl", body, "C:/work/k")
	text := importText(t, meta.File)
	if got := strings.Count(text, "\"role\":\"user\""); got != 1 {
		t.Fatalf("the user's message was imported %d times:\n%s", got, text)
	}
	if filepath.Clean(meta.Cwd) != filepath.Clean("C:/work/k") {
		t.Fatalf("cwd = %q", meta.Cwd)
	}
	// The source's token counts survive: the session panel reads them.
	file := importText(t, meta.File)
	for _, want := range []string{`"input":11`, `"output":7`, `"cacheRead":5`, `"cacheWrite":3`, `"totalTokens":26`} {
		if !strings.Contains(file, want) {
			t.Errorf("imported usage lacks %q:\n%s", want, file)
		}
	}
}

// TestImportCodeBuddyFlushesPending checks that reasoning and a tool call
// become one assistant turn, with the result after it.
func TestImportCodeBuddyFlushesPending(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder>x</system-reminder>跑一下测试"}],"timestamp":"2026-06-01T10:00:00Z"}`,
		`{"type":"reasoning","rawContent":[{"type":"reasoning_text","text":"先跑测试"}],"timestamp":"2026-06-01T10:00:01Z"}`,
		`{"type":"function_call","callId":"fc1","name":"run","arguments":"{\"command\":\"go test\"}","timestamp":"2026-06-01T10:00:02Z"}`,
		`{"type":"function_call_result","callId":"fc1","name":"run","status":"completed","output":{"type":"text","text":"ok"},"timestamp":"2026-06-01T10:00:03Z"}`,
	}, "\n") + "\n"
	meta := importFixture(t, CodeBuddy, dir, "s1.jsonl", body, "")
	text := importText(t, meta.File)
	for _, want := range []string{"跑一下测试", "先跑测试", `"type":"toolCall"`, `"toolCallId":"fc1"`, "ok"} {
		if !strings.Contains(text, want) {
			t.Errorf("imported session lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "system-reminder>x") {
		t.Error("the injected reminder was imported")
	}
}

// TestScanSourceListsOnce checks a store scan: the sessions of one source,
// with the state each has here.
func TestScanSourceListsOnce(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "C--work--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i, text := range []string{"甲", "乙"} {
		body := `{"type":"user","sessionId":"c` + string(rune('1'+i)) + `","cwd":"C:/work","timestamp":"2026-06-01T10:0` + string(rune('0'+i)) + `:00Z","message":{"role":"user","content":"` + text + `"}}` + "\n"
		if err := os.WriteFile(filepath.Join(dir, "c"+string(rune('1'+i))+".jsonl"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := Scan(Source{
		Key: Claude.Key, Label: Claude.Label, Version: Claude.Version,
		Roots: func() []string { return []string{root} },
		Scan:  Claude.Scan, Read: Claude.Read, Sniff: Claude.Sniff,
	}, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	for _, row := range rows {
		if row.State != New || row.Cwd != "C:/work" {
			t.Fatalf("row = %+v", row)
		}
	}
}

// createSQLite makes a database for a source's test, with the given
// statements run in order.
func createSQLite(t *testing.T, path string, statements ...string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("sql %q: %v", stmt, err)
		}
	}
}

// TestImportOpenCode reads a session out of a small OpenCode database.
func TestImportOpenCode(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	dbPath := OpenCodeDB(root)
	createSQLite(t, dbPath,
		`create table project (id text, worktree text)`,
		`create table session (id text, project_id text, directory text, title text, time_updated integer)`,
		`create table message (id text, session_id text, time_created integer, time_updated integer, data text)`,
		`create table part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text)`,
		`insert into project values ('p','C:/work/o')`,
		`insert into session values ('ses_1','p','C:/work/o','写测试',500)`,
		`insert into message values ('m1','ses_1',100,100,'{"role":"user"}')`,
		`insert into message values ('m2','ses_1',200,200,'{"role":"assistant","finish":"stop"}')`,
		`insert into part values ('p1','m1','ses_1',100,100,'{"type":"text","text":"写个测试"}')`,
		`insert into part values ('p2','m2','ses_1',200,200,'{"type":"reasoning","text":"想一下"}')`,
		`insert into part values ('p3','m2','ses_1',200,200,'{"type":"text","text":"写好了"}')`,
	)
	cands, err := ScanOpenCode(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 1 || cands[0].Title != "写测试" {
		t.Fatalf("candidates = %+v", cands)
	}
	parsed, err := OpenCode.Read(cands[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Messages) != 2 {
		t.Fatalf("messages = %d, want 2: %+v", len(parsed.Messages), parsed.Messages)
	}
	if parsed.Messages[1].Blocks[0].Kind != "thinking" {
		t.Fatalf("assistant blocks = %+v", parsed.Messages[1].Blocks)
	}
}

// TestImportOpenCodeV2 reads a session out of OpenCode 2.x's schema, which
// names its rows differently and orders them by sequence.
func TestImportOpenCodeV2(t *testing.T) {
	root := t.TempDir()
	dbPath := OpenCodeDB(root)
	createSQLite(t, dbPath,
		`create table project (id text, worktree text)`,
		`create table session_v2 (id text, project_id text, parent_id text, directory text, title text, time_updated integer)`,
		`create table session_message (id text, session_id text, seq integer, type text, time_created integer, time_updated integer, data text)`,
		`insert into project values ('p','C:/work/v2')`,
		`insert into session_v2 values ('ses_v2','p',null,'C:/work/v2','二代会话',900)`,
		`insert into session_v2 values ('ses_child','p','ses_v2','C:/work/v2','子代理',950)`,
		`insert into session_message values ('sm1','ses_v2',1,'user',100,100,'{"text":"<system-reminder>ctx</system-reminder>看图","files":[{"name":"a.png","mime":"image/png","data":"aGk="}]}')`,
		`insert into session_message values ('sm2','ses_v2',2,'assistant',200,200,'{"finish":"tool-calls","model":{"id":"m1","providerID":"prov"},"tokens":{"input":9,"output":4,"cache":{"read":2,"write":1}},"content":[{"type":"reasoning","text":"想一下"},{"type":"text","text":"看一下"},{"type":"tool","id":"call-v2","name":"view","state":{"status":"completed","input":{"path":"a.png"},"content":[{"type":"text","text":"图片内容"}]}}]}')`,
		`insert into session_message values ('sm3','ses_v2',3,'model-switched',300,300,'{"model":"m2"}')`,
	)
	cands, err := ScanOpenCode(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 1 || cands[0].ID != "ses_v2" || cands[0].Cwd != "C:/work/v2" {
		t.Fatalf("candidates = %+v", cands)
	}
	parsed, err := OpenCode.Read(cands[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Messages) != 3 {
		t.Fatalf("messages = %d, want user, assistant and result: %+v", len(parsed.Messages), parsed.Messages)
	}
	user := parsed.Messages[0]
	if user.Role != "user" || len(user.Blocks) != 2 || user.Blocks[0].Text != "看图" || user.Blocks[1].Kind != "image" {
		t.Fatalf("user message = %+v", user)
	}
	assistant := parsed.Messages[1]
	if assistant.Usage == nil || assistant.Usage.Input != 9 || assistant.Usage.CacheRead != 2 || assistant.Usage.CacheWrite != 1 {
		t.Fatalf("usage = %+v", assistant.Usage)
	}
	if assistant.Provider != "prov" || assistant.Model != "m1" || assistant.StopReason != "toolUse" {
		t.Fatalf("assistant = %+v", assistant)
	}
	result := parsed.Messages[2]
	if result.Role != "toolResult" || result.ToolCallID != "call-v2" || result.Text != "图片内容" {
		t.Fatalf("tool result = %+v", result)
	}
}
