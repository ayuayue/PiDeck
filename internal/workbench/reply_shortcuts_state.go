//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf16"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type replyShortcutState struct {
	data    *core.Signal[replyShortcuts]
	picker  *core.Signal[*session]
	query   *core.Signal[string]
	window  *core.Signal[int]
	loading *core.Signal[bool]
	message *core.Signal[string]
	form    *core.Signal[*replyShortcutForm]
	loadSeq uint64
	ruleSeq uint64
}

type replyShortcutForm struct {
	phraseRef *core.Ref
	phrases   *core.Signal[string]
	rules     *core.Signal[[]*replyRuleForm]
	busy      *core.Signal[bool]
	message   *core.Signal[string]
	window    *core.Signal[int]
	section   *core.Signal[string]
	editing   *core.Signal[string]
}

// Each rule form owns stable signals; typing never changes its row identity.
type replyRuleForm struct {
	id                   string
	textRef              *core.Ref
	text, when, patterns *core.Signal[string]
	files                *core.Signal[bool]
	original             []replyActionTrigger
	conditionsEdited     bool
}

func newReplyShortcutState(cx *core.Scope) *replyShortcutState {
	return &replyShortcutState{
		data: core.NewSignalFunc(cx, replyShortcuts{Version: 1}, nil), picker: core.NewSignal(cx, (*session)(nil)),
		query: core.NewSignal(cx, ""), window: core.NewSignal(cx, 10), loading: core.NewSignal(cx, false),
		message: core.NewSignal(cx, ""), form: core.NewSignal(cx, (*replyShortcutForm)(nil)),
	}
}

// Reads happen on startup and whenever either entry opens. Sequence ownership
// prevents a late refresh from replacing a newly saved snapshot.
func (a *app) refreshReplyShortcuts(done func(replyShortcuts)) {
	if a.st == nil {
		return
	}
	q := a.quickReplies
	q.loadSeq++
	seq, dir := q.loadSeq, a.st.dir
	q.loading.Set(true)
	go func() {
		data, err := readReplyShortcuts(dir)
		a.cx.Post(func() {
			if q.loadSeq != seq {
				return
			}
			q.loading.Set(false)
			q.data.Set(data)
			q.message.Set("")
			if err != nil {
				q.message.Set(apptext.T("快捷回复配置无法读取；请检查配置文件后重试。"))
			}
			if done != nil {
				done(data)
			}
		})
	}()
}

func (a *app) openQuickMessages(s *session) {
	q := a.quickReplies
	if q.picker.GetUntracked() != nil {
		q.picker.Set(nil)
		return
	}
	if s == nil {
		return
	}
	q.query.Set("")
	q.window.Set(10)
	q.picker.Set(s)
	a.refreshReplyShortcuts(nil)
}

func (a *app) shortcutSendAllowed(s *session) bool {
	return s != nil && a.byID[s.ID] == s && !s.deleting && !a.composerBlocked(s) && !modeOn(s, modeImage) && a.aiBusy.Get() != "image" && s.askPending.Get() == 0
}

// Shortcuts send their own prompt and never consume draft text, composition,
// image attachments or pasted files. submit owns trust, modes and startup.
func (a *app) sendShortcut(s *session, text string) {
	if !a.shortcutSendAllowed(s) || strings.TrimSpace(text) == "" {
		return
	}
	if s.busyNow() {
		if delivery(s) == deliveryFollowUp || backendOf(s) == "acp" {
			a.queueFollowUp(s, text, nil)
		} else {
			a.steer(s, text, nil)
		}
		return
	}
	a.submit(s, text, nil)
}

func (a *app) insertShortcut(s *session, text string) {
	if s == nil || a.byID[s.ID] != s || s.deleting {
		return
	}
	draft := s.draft.GetUntracked()
	if draft != "" && !strings.HasSuffix(draft, "\n") {
		draft += "\n"
	}
	s.draft.Set(draft + text)
}

func (a *app) makeReplyRuleForm(rule replyActionRule) *replyRuleForm {
	when, patterns := "always", []string{}
	for _, trigger := range rule.Triggers {
		if trigger.Kind == "textMatch" {
			patterns = append(patterns, trigger.Patterns...)
		} else {
			when = trigger.Kind
		}
	}
	id := "shortcut-rule-" + rule.Text
	if rule.Text == "" {
		a.quickReplies.ruleSeq++
		id += "new-" + strconv.FormatUint(a.quickReplies.ruleSeq, 10)
	}
	return &replyRuleForm{id: id, textRef: new(core.Ref), text: core.NewSignal(a.cx, rule.Text), when: core.NewSignal(a.cx, when), patterns: core.NewSignal(a.cx, strings.Join(patterns, "\n")), files: core.NewSignal(a.cx, rule.Requires == "fileEdits"), original: rule.Triggers}
}

func (a *app) fillReplyShortcutForm(f *replyShortcutForm, data replyShortcuts) {
	f.phrases.Set(strings.Join(data.QuickMessages, "\n"))
	rules := make([]*replyRuleForm, 0, len(data.ReplyActions))
	for _, rule := range data.ReplyActions {
		rules = append(rules, a.makeReplyRuleForm(rule))
	}
	f.rules.Set(rules)
	f.editing.Set("")
	f.window.Set(6)
}

func (a *app) openReplyShortcutSettings() {
	a.openReplyShortcutSettingsFor("")
}

func (a *app) openReplyShortcutSettingsFor(phrase string) {
	q := a.quickReplies
	if a.st == nil || q.form.GetUntracked() != nil {
		return
	}
	q.picker.Set(nil)
	f := &replyShortcutForm{
		phraseRef: new(core.Ref), phrases: core.NewSignal(a.cx, ""), rules: core.NewSignalFunc(a.cx, []*replyRuleForm{}, nil),
		busy: core.NewSignal(a.cx, true), message: core.NewSignal(a.cx, ""), window: core.NewSignal(a.cx, 6),
		section: core.NewSignal(a.cx, "phrases"), editing: core.NewSignal(a.cx, ""),
	}
	q.form.Set(f)
	a.refreshReplyShortcuts(func(data replyShortcuts) {
		if q.form.GetUntracked() != f {
			return
		}
		a.fillReplyShortcutForm(f, data)
		f.busy.Set(false)
		f.message.Set(q.message.GetUntracked())
		if phrase != "" {
			// Focus after the loaded field is enabled, and select in the
			// platform's UTF-16 units even when earlier phrases contain emoji.
			a.cx.Post(func() {
				if q.form.GetUntracked() != f || f.busy.GetUntracked() {
					return
				}
				value, at := f.phrases.GetUntracked(), 0
				for _, line := range strings.Split(value, "\n") {
					if line == phrase {
						start := len(utf16.Encode([]rune(value[:at])))
						f.phraseRef.Focus()
						f.phraseRef.SetSelection(start, start+len(utf16.Encode([]rune(phrase))))
						return
					}
					at += len(line) + 1
				}
			})
		}
	})
}

func shortcutLines(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

func replyShortcutFormData(f *replyShortcutForm) replyShortcuts {
	data := replyShortcuts{Version: 1, QuickMessages: shortcutLines(f.phrases.GetUntracked()), ReplyActions: []replyActionRule{}}
	for _, r := range f.rules.GetUntracked() {
		rule := replyActionRule{Text: r.text.GetUntracked(), Triggers: r.original}
		if r.conditionsEdited {
			rule.Triggers = []replyActionTrigger{{Kind: r.when.GetUntracked()}}
			if patterns := shortcutLines(r.patterns.GetUntracked()); len(patterns) > 0 {
				rule.Triggers = append(rule.Triggers, replyActionTrigger{Kind: "textMatch", Patterns: patterns})
			}
		}
		if r.files.GetUntracked() {
			rule.Requires = "fileEdits"
		}
		data.ReplyActions = append(data.ReplyActions, rule)
	}
	return data
}

func (a *app) saveReplyShortcutForm(f *replyShortcutForm) {
	q := a.quickReplies
	if q.form.GetUntracked() != f || f.busy.GetUntracked() {
		return
	}
	data := replyShortcutFormData(f)
	f.busy.Set(true)
	f.message.Set("")
	q.loadSeq++
	q.loading.Set(false)
	dir := a.st.dir
	go func() {
		clean, err := saveReplyShortcuts(dir, data)
		a.cx.Post(func() {
			f.busy.Set(false)
			if err != nil {
				if errors.Is(err, errInvalidReplyShortcuts) || errors.Is(err, errLargeReplyShortcuts) {
					f.message.Set(apptext.T(err.Error()))
				} else {
					f.message.Set(apptext.T("保存失败，请重试。"))
				}
				return
			}
			q.data.Set(clean)
			q.message.Set("")
			q.form.Set(nil)
			a.toast(ui.ToastSuccess, apptext.T("快捷短语与回复规则已保存"), "")
		})
	}()
}
