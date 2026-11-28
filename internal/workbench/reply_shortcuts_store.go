//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"example.com/pideck/internal/apptext"
	yaml "go.yaml.in/yaml/v3"
)

const replyShortcutsFile = "reply-shortcuts.yaml"
const replyShortcutsLimit = 30
const replyShortcutsMaxBytes = 256 << 10

var (
	errInvalidReplyShortcuts = errors.New("快捷短语或回复规则无效；请检查空文本、数量上限和正则表达式。")
	errLargeReplyShortcuts   = errors.New("快捷回复配置超过 256 KB。")
)

// replyShortcuts is the desktop's single persisted source for both lists.
// Missing files use defaults; empty lists deliberately disable the feature.
type replyShortcuts struct {
	Version       int               `yaml:"version"`
	QuickMessages []string          `yaml:"quickMessages"`
	ReplyActions  []replyActionRule `yaml:"replyActions"`
}

type replyActionRule struct {
	Text     string               `yaml:"text"`
	Triggers []replyActionTrigger `yaml:"triggers"`
	Requires string               `yaml:"requires,omitempty"`
}

type replyActionTrigger struct {
	Kind     string   `yaml:"kind"`
	Patterns []string `yaml:"patterns,omitempty"`
	compiled []*regexp.Regexp
}

func defaultReplyShortcuts() replyShortcuts {
	stop := replyActionTrigger{Kind: "onStop"}
	match := func(patterns ...string) replyActionTrigger {
		return replyActionTrigger{Kind: "textMatch", Patterns: patterns}
	}
	return replyShortcuts{Version: 1,
		QuickMessages: []string{
			apptext.T("你好，你是什么模型"), apptext.T("你好"), apptext.T("请问你是什么模型"), apptext.T("继续"),
			apptext.T("提交"), apptext.T("推送"), apptext.T("提交推送"), apptext.T("随便用ask提问我"),
			apptext.T("用中文回答我"), apptext.T("给出完整可运行的文件"), apptext.T("只改我提到的部分，不要顺手改其它代码"),
			apptext.T("参考项目里已有的实现和代码风格"), apptext.T("不要添加不必要的注释"), apptext.T("请仔细思考，确保正确且完整实现"),
			apptext.T("再确认一下"), apptext.T("还是不对，请重新排查"), apptext.T("还是无法运行，先看报错再修"),
			apptext.T("先检索查证再回答，不要凭猜测下结论"), apptext.T("先别写代码，先梳理方案"), apptext.T("review 一下这个 commit"),
		},
		ReplyActions: []replyActionRule{
			{Text: apptext.T("继续"), Triggers: []replyActionTrigger{stop}},
			{Text: apptext.T("再确认一下"), Triggers: []replyActionTrigger{stop, match("需要确认|请确认|待确认|请审阅|是否需要|要不要|需不需要|需要我|不确定|可能有风险|需要注意|please confirm|would you like|needs? review")}},
			{Text: apptext.T("提交"), Requires: "fileEdits", Triggers: []replyActionTrigger{stop, match("完成|搞定|已实现|已修复|已支持|已处理|已更新|已新增|改完|写完|做完|测试通过|全部通过|验证通过|全绿|收尾|可以提交|可提交|待提交|completed|implemented|fixed|tests? pass|ready to commit")}},
			{Text: apptext.T("提交并推送"), Requires: "fileEdits", Triggers: []replyActionTrigger{stop, match("完成|搞定|已实现|已修复|测试通过|验证通过|可以提交|completed|implemented|fixed|tests? pass|ready to commit")}},
			{Text: apptext.T("运行测试看看结果"), Triggers: []replyActionTrigger{stop, match("测试|单测|回归|spec|test|npm run|全绿")}},
			{Text: apptext.T("重新排查"), Triggers: []replyActionTrigger{{Kind: "onFailure"}}},
			{Text: apptext.T("检查报错并修复"), Triggers: []replyActionTrigger{{Kind: "onFailure"}}},
			{Text: apptext.T("重试一次"), Triggers: []replyActionTrigger{{Kind: "onFailure"}}},
		}}
}

func validShortcutText(text string) bool {
	return strings.TrimSpace(text) != "" && len(text) <= 2000 && utf8.ValidString(text) && !strings.ContainsRune(text, 0)
}

func compileReplyAction(rule replyActionRule) (replyActionRule, bool) {
	if !validShortcutText(rule.Text) || len(rule.Triggers) == 0 || len(rule.Triggers) > 8 || (rule.Requires != "" && rule.Requires != "fileEdits") {
		return replyActionRule{}, false
	}
	rule.Text = strings.TrimSpace(rule.Text)
	rule.Triggers = append([]replyActionTrigger(nil), rule.Triggers...)
	for i := range rule.Triggers {
		trigger := &rule.Triggers[i]
		trigger.compiled = nil
		switch trigger.Kind {
		case "always", "onStop", "onFailure":
		case "textMatch":
			if len(trigger.Patterns) == 0 || len(trigger.Patterns) > 30 {
				return replyActionRule{}, false
			}
			for _, pattern := range trigger.Patterns {
				if strings.TrimSpace(pattern) == "" || len(pattern) > 2000 {
					return replyActionRule{}, false
				}
				re, err := regexp.Compile("(?i)" + pattern)
				if err != nil {
					return replyActionRule{}, false
				}
				trigger.compiled = append(trigger.compiled, re)
			}
		default:
			return replyActionRule{}, false
		}
	}
	return rule, true
}

// prepareReplyShortcuts discards individual bad items on read. Saves are strict,
// so a typo cannot silently remove an item the user is currently editing.
func prepareReplyShortcuts(in replyShortcuts, strict bool) (replyShortcuts, error) {
	if in.Version != 1 || len(in.QuickMessages) > replyShortcutsLimit || len(in.ReplyActions) > replyShortcutsLimit {
		return replyShortcuts{Version: 1}, errInvalidReplyShortcuts
	}
	out := replyShortcuts{Version: 1, QuickMessages: []string{}, ReplyActions: []replyActionRule{}}
	seen := map[string]bool{}
	for _, text := range in.QuickMessages {
		if !validShortcutText(text) {
			if strict {
				return out, errInvalidReplyShortcuts
			}
			continue
		}
		text = strings.TrimSpace(text)
		if !seen[text] {
			out.QuickMessages = append(out.QuickMessages, text)
			seen[text] = true
		}
	}
	seen = map[string]bool{}
	for _, rule := range in.ReplyActions {
		clean, ok := compileReplyAction(rule)
		if !ok {
			if strict {
				return out, errInvalidReplyShortcuts
			}
			continue
		}
		if !seen[clean.Text] {
			out.ReplyActions = append(out.ReplyActions, clean)
			seen[clean.Text] = true
		}
	}
	return out, nil
}

func readReplyShortcuts(dir string) (replyShortcuts, error) {
	f, err := os.Open(filepath.Join(dir, replyShortcutsFile))
	if errors.Is(err, os.ErrNotExist) {
		return prepareReplyShortcuts(defaultReplyShortcuts(), true)
	}
	if err != nil {
		return replyShortcuts{Version: 1}, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, replyShortcutsMaxBytes+1))
	if err != nil {
		return replyShortcuts{Version: 1}, err
	}
	if len(raw) > replyShortcutsMaxBytes {
		return replyShortcuts{Version: 1}, errLargeReplyShortcuts
	}
	var data replyShortcuts
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if err := decoder.Decode(&data); err != nil {
		return replyShortcuts{Version: 1}, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return replyShortcuts{Version: 1}, errors.New("快捷回复配置只能包含一个 YAML 文档。")
	}
	return prepareReplyShortcuts(data, false)
}

func saveReplyShortcuts(dir string, data replyShortcuts) (replyShortcuts, error) {
	clean, err := prepareReplyShortcuts(data, true)
	if err != nil {
		return clean, err
	}
	raw, err := yaml.Marshal(clean)
	if err != nil {
		return clean, err
	}
	if len(raw) > replyShortcutsMaxBytes {
		return clean, errLargeReplyShortcuts
	}
	return clean, writeFileAtomic(filepath.Join(dir, replyShortcutsFile), raw, 0o600)
}
