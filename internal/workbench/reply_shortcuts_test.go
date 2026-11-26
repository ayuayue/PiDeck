//go:build !js && !android && !ios

package workbench

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestReplyShortcutsStore(t *testing.T) {
	dir := t.TempDir()
	defaults, err := readReplyShortcuts(dir)
	if err != nil || len(defaults.QuickMessages) == 0 || len(defaults.ReplyActions) == 0 {
		t.Fatalf("defaults = %+v, %v", defaults, err)
	}
	data := replyShortcuts{Version: 1, QuickMessages: []string{" hello ", "hello", "世界"}, ReplyActions: []replyActionRule{{Text: "test", Triggers: []replyActionTrigger{{Kind: "onStop"}, {Kind: "textMatch", Patterns: []string{"done"}}}}}}
	if _, err := saveReplyShortcuts(dir, data); err != nil {
		t.Fatal(err)
	}
	loaded, err := readReplyShortcuts(dir)
	if err != nil || !reflect.DeepEqual(loaded.QuickMessages, []string{"hello", "世界"}) || len(loaded.ReplyActions) != 1 {
		t.Fatalf("round trip = %+v, %v", loaded, err)
	}
	if got := matchedReplyActions(loaded.ReplyActions, []turn{{Status: chat.Completed, Final: "DONE"}}); !reflect.DeepEqual(got, []string{"test"}) {
		t.Fatalf("compiled round trip = %v", got)
	}
	if _, err := saveReplyShortcuts(dir, replyShortcuts{Version: 1}); err != nil {
		t.Fatal(err)
	}
	empty, err := readReplyShortcuts(dir)
	if err != nil || len(empty.QuickMessages) != 0 || len(empty.ReplyActions) != 0 {
		t.Fatalf("empty configuration restored defaults: %+v, %v", empty, err)
	}
	if !backupPathAllowed(replyShortcutsFile) {
		t.Fatal("shortcuts missing from settings backup allowlist")
	}
	a := &app{st: &store{dir: dir}}
	raw, err := a.settingsZip()
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	names, err := settingsArchiveNames(zr)
	if err != nil || !reflect.DeepEqual(names, []string{replyShortcutsFile}) {
		t.Fatalf("backup names = %v, %v", names, err)
	}
}

func TestReplyShortcutsRejectInvalidSaveAndDegradeRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, replyShortcutsFile)
	good := replyShortcuts{Version: 1, QuickMessages: []string{"keep"}}
	if _, err := saveReplyShortcuts(dir, good); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	for _, data := range []replyShortcuts{
		{Version: 2},
		{Version: 1, QuickMessages: make([]string, replyShortcutsLimit+1)},
		{Version: 1, QuickMessages: []string{""}},
		{Version: 1, ReplyActions: []replyActionRule{{Text: "bad", Triggers: []replyActionTrigger{{Kind: "textMatch", Patterns: []string{"["}}}}}},
		{Version: 1, ReplyActions: []replyActionRule{{Text: "bad", Triggers: []replyActionTrigger{{Kind: "unknown"}}}}},
	} {
		if _, err := saveReplyShortcuts(dir, data); err == nil {
			t.Fatalf("invalid save accepted: %+v", data)
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
			t.Fatal("rejected save changed existing file")
		}
	}
	fixture := "version: 1\nquickMessages: [hello, '']\nreplyActions:\n  - text: bad\n    triggers: [{kind: textMatch, patterns: ['[']}]\n  - text: good\n    triggers: [{kind: onStop}]\n"
	if err := os.WriteFile(path, []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readReplyShortcuts(dir)
	if err != nil || len(data.QuickMessages) != 1 || len(data.ReplyActions) != 1 || data.ReplyActions[0].Text != "good" {
		t.Fatalf("bad item isolation = %+v, %v", data, err)
	}
	for _, raw := range []string{"not: [yaml", "version: 9\nquickMessages: [hello]", "version: 1\n---\nversion: 1", strings.Repeat("x", replyShortcutsMaxBytes+1)} {
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := readReplyShortcuts(dir)
		if err == nil || len(got.ReplyActions) != 0 || len(got.QuickMessages) != 0 {
			t.Fatalf("corrupt read = %+v, %v", got, err)
		}
		if after, _ := os.ReadFile(path); string(after) != raw {
			t.Fatal("corrupt file was overwritten")
		}
	}
}

func TestReplyShortcutsMatchLatestTurn(t *testing.T) {
	apptext.SetLanguage(apptext.LangZhCN)
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	data, err := prepareReplyShortcuts(defaultReplyShortcuts(), true)
	if err != nil {
		t.Fatal(err)
	}
	edit := turnStep{Tools: []toolRun{{Action: "编辑", Detail: "app.go", Status: chat.Completed}}}
	for _, tc := range []struct {
		name  string
		turns []turn
		want  []string
	}{
		{"empty", nil, nil},
		{"success", []turn{{Status: chat.Completed, Final: "你好"}}, []string{"继续"}},
		{"question", []turn{{Status: chat.Completed, Final: "请确认是否需要修改"}}, []string{"继续", "再确认一下"}},
		{"code", []turn{{Status: chat.Completed, Final: "例子：\n```\n测试通过，完成，请确认\n```\n`完成`"}}, []string{"继续"}},
		{"thinking", []turn{{Status: chat.Completed, Final: "<think>测试通过，请确认</think>你好"}}, []string{"继续"}},
		{"no edits", []turn{{Status: chat.Completed, Final: "已完成"}}, []string{"继续"}},
		{"edits", []turn{{Status: chat.Completed, Steps: []turnStep{edit}}, {Status: chat.Completed, Final: "已完成，测试通过"}}, []string{"继续", "提交", "提交并推送", "运行测试看看结果"}},
		{"failure", []turn{{Status: chat.Failed, Err: "bad request", Final: "已完成"}}, []string{"重新排查", "检查报错并修复", "重试一次"}},
		{"cancelled", []turn{{Status: chat.Cancelled, Final: "完成"}}, nil},
		{"new running turn", []turn{{Status: chat.Completed, Final: "请确认"}, {Status: chat.Running}}, nil},
		{"retry waiting", []turn{{Status: chat.Waiting, Final: "请确认"}}, nil},
		{"system", []turn{{Status: chat.Completed, Final: "完成", System: true}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchedReplyActions(data.ReplyActions, tc.turns); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("matches = %q, want %q", got, tc.want)
			}
		})
	}
	badEdit := edit
	badEdit.Tools = []toolRun{{Action: "编辑", Detail: "app.go", Status: chat.Failed, IsError: true}}
	if got := matchedReplyActions(data.ReplyActions, []turn{{Status: chat.Completed, Final: "完成", Steps: []turnStep{badEdit}}}); !reflect.DeepEqual(got, []string{"继续"}) {
		t.Fatalf("failed edit offered commit: %v", got)
	}
	rule, _ := compileReplyAction(replyActionRule{Text: "any", Triggers: []replyActionTrigger{{Kind: "always"}}})
	if got := matchedReplyActions([]replyActionRule{rule, rule}, []turn{{Status: chat.Cancelled}}); !reflect.DeepEqual(got, []string{"any"}) {
		t.Fatalf("always / dedupe = %v", got)
	}
}

func replyShortcutFixture(t *testing.T) (*nsgotest.App, *app, *session) {
	t.Helper()
	fakeProviders(t)
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sessionDraftWrites.Wait)
	var a *app
	var s *session
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		s = a.makeSession(sessionMeta{ID: "shortcuts", Title: "Shortcut fixture"}, localTarget)
		a.activeID.Set(s.ID)
		s.turns.Set([]turn{{ID: "reply-1", Status: chat.Completed, Final: "你好"}})
		return core.View{Style: ui.FillRest, Children: []core.Node{
			a.composerAccessory(s)(cx),
			a.turnReplyShortcuts(s, func() turn { return s.turns.Get()[0] }),
			a.quickMessagesDialog(), a.replyShortcutSettingsDialog(),
		}}
	}, nsgotest.Size(1100, 760))
	t.Cleanup(a.closeDiag)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	return screen, a, s
}

func TestReplyShortcutsPickerAndDraftIsolation(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless behavior regression")
	}
	screen, a, s := replyShortcutFixture(t)
	s.draft.Set("unfinished")
	s.images.Set([]remotewire.Image{{MimeType: "image/png", Data: []byte("draft-image")}})
	a.openQuickMessages(s)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	screen.Type("id:quick-messages-search", "继续")
	screen.Press("id:quick-insert-继续")
	if got := s.draft.GetUntracked(); got != "unfinished\n继续" {
		t.Fatalf("insert replaced draft: %q", got)
	}
	s.draft.Set("keep me")
	s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
	s.runningSig.Set(true)
	s.sendMode.Set(deliveryFollowUp)
	a.openQuickMessages(s)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	screen.Press("id:quick-send-继续")
	if got := s.sending.GetUntracked(); len(got) != 1 || got[0].Text != "继续" || len(got[0].Images) != 0 {
		t.Fatalf("shortcut queue = %+v", got)
	}
	if s.draft.GetUntracked() != "keep me" || len(s.images.GetUntracked()) != 1 {
		t.Fatal("direct send consumed draft or attachments")
	}
	s.retrying.Set(true)
	a.sendShortcut(s, "blocked")
	if len(s.sending.GetUntracked()) != 1 {
		t.Fatal("shortcut sent during retry")
	}
}

func TestReplyShortcutsSettingsSaveAndFailure(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless persistence regression")
	}
	screen, a, _ := replyShortcutFixture(t)
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	f := a.quickReplies.form.GetUntracked()
	f.phrases.Set("custom\nsecond")
	f.rules.Set(nil)
	screen.Press("id:shortcut-save")
	screen.WaitUntil(5*time.Second, func() bool { return a.quickReplies.form.GetUntracked() == nil })
	if got, err := readReplyShortcuts(a.st.dir); err != nil || !reflect.DeepEqual(got.QuickMessages, []string{"custom", "second"}) || len(got.ReplyActions) != 0 {
		t.Fatalf("saved form = %+v, %v", got, err)
	}
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	f = a.quickReplies.form.GetUntracked()
	f.phrases.Set("do not publish")
	path := filepath.Join(a.st.dir, replyShortcutsFile)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:shortcut-save")
	screen.WaitUntil(5*time.Second, func() bool { return !f.busy.GetUntracked() })
	if a.quickReplies.form.GetUntracked() != f || f.message.GetUntracked() == "" || a.quickReplies.data.GetUntracked().QuickMessages[0] != "custom" {
		t.Fatal("failed save closed editor or published unpersisted data")
	}
}

func TestReplyShortcutsNativeLayout(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot regression")
	}
	a, screen, s := startNativeSurfaceApp(t)
	screen.RightClick("id:chat-reply")
	screen.WaitFor("id:reply-action-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/reply")
	screen.Key("escape")
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-send-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/picker")
	screen.Press("id:quick-messages-manage")
	screen.WaitUntil(5*time.Second, func() bool {
		return a.quickReplies.form.GetUntracked() != nil && !a.quickReplies.form.GetUntracked().busy.GetUntracked()
	})
	screen.Screenshot("reply-shortcuts/settings")
	onNativeUI(t, screen, a, func() { a.quickReplies.form.Set(nil); s.draft.Set("保留未发送的草稿") })
	screen.Resize(760, 640)
	screen.Press("id:composer-quick-messages")
	screen.WaitFor("id:quick-send-继续", 5*time.Second)
	screen.Screenshot("reply-shortcuts/picker-narrow")
}

func TestReplyShortcutsReactiveAndRuleEditor(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless reactive regression")
	}
	screen, a, s := replyShortcutFixture(t)
	screen.WaitFor("id:reply-action-继续", 5*time.Second)
	s.agentMode.Set(modeImage)
	screen.Settle()
	if screen.Exists("id:reply-action-strip") {
		t.Fatal("reply suggestions remained in image mode")
	}
	s.agentMode.Set(modeNormal)
	screen.WaitFor("id:reply-action-继续", 5*time.Second)
	s.turns.Set([]turn{{ID: "reply-1", Status: chat.Running}})
	screen.Settle()
	if screen.Exists("id:reply-action-strip") {
		t.Fatal("reply suggestions remained while running")
	}
	s.turns.Set([]turn{{ID: "reply-1", Status: chat.Failed, Err: "fixture"}})
	screen.WaitFor("id:reply-action-重新排查", 5*time.Second)
	a.openReplyShortcutSettings()
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.form.GetUntracked().busy.GetUntracked() })
	f := a.quickReplies.form.GetUntracked()
	screen.Type("id:shortcut-rule-继续-text", " more")
	if got := f.rules.GetUntracked()[0].text.GetUntracked(); got != "继续 more" {
		t.Fatalf("rule text edit = %q", got)
	}
	screen.Press("id:shortcut-rule-继续-delete")
	if len(f.rules.GetUntracked()) != 7 {
		t.Fatal("delete did not remove the selected rule")
	}
	screen.Press("id:shortcut-rule-add")
	if len(f.rules.GetUntracked()) != 8 {
		t.Fatal("add did not append a rule")
	}
	rule := f.rules.GetUntracked()[7]
	rule.patterns.Set("[")
	rule.conditionsEdited = true
	screen.Press("id:shortcut-save")
	screen.WaitUntil(5*time.Second, func() bool { return !f.busy.GetUntracked() })
	if f.message.GetUntracked() == "" || a.quickReplies.form.GetUntracked() != f {
		t.Fatal("invalid pattern was saved or editor closed")
	}
	screen.Press("id:shortcut-defaults")
	if len(f.rules.GetUntracked()) != 8 {
		t.Fatal("restore defaults did not replace rules")
	}
	screen.Press("id:shortcut-cancel")
	if a.quickReplies.form.GetUntracked() != nil {
		t.Fatal("cancel did not close the editor")
	}
}

func TestReplyShortcutsCommandRegistration(t *testing.T) {
	var quick, rules bool
	for _, cmd := range builtinCommands() {
		switch cmd.ID {
		case "quick-messages":
			quick = true
			if cmd.Shortcut != "mod+shift+m" || cmd.When == nil || cmd.Run == nil {
				t.Fatalf("quick messages command = %+v", cmd)
			}
		case "reply-shortcuts":
			rules = true
			if cmd.Run == nil {
				t.Fatal("rule management command has no handler")
			}
		}
	}
	if !quick || !rules {
		t.Fatalf("missing commands: quick=%t rules=%t", quick, rules)
	}
}
