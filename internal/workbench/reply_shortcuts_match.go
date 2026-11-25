//go:build !js && !android && !ios

package workbench

import (
	"regexp"
	"strings"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Match prose only: quoted code and thinking are not requests to the user.
var replyShortcutCode = regexp.MustCompile("(?s)```.*?(?:```|$)|~~~.*?(?:~~~|$)|`[^`\n]*`|(?i:<think(?:ing)?>.*?(?:</think(?:ing)?>|$))")

func matchedReplyActions(rules []replyActionRule, turns []turn) []string {
	if len(turns) == 0 {
		return nil
	}
	last := turns[len(turns)-1]
	if last.System || last.running() {
		return nil
	}
	failed := last.Status == chat.Failed
	stopped := last.Status == chat.Completed && strings.TrimSpace(last.Final) != "" && last.Err == ""
	if !failed && !stopped && last.Status != chat.Cancelled {
		return nil
	}
	prose := ""
	if stopped {
		prose = replyShortcutCode.ReplaceAllString(last.Final, " ")
	}
	fileEdits := false
	for _, t := range turns {
		for _, step := range t.Steps {
			for _, run := range step.Tools {
				if !run.IsError && run.Status == chat.Completed && run.Detail != "" && (run.Action == "编辑" || run.Action == "写入") {
					fileEdits = true
				}
			}
		}
	}
	var texts []string
	seen := map[string]bool{}
	for _, rule := range rules {
		if seen[rule.Text] || (rule.Requires != "" && (rule.Requires != "fileEdits" || !fileEdits)) || len(rule.Triggers) == 0 {
			continue
		}
		matches := true
		for _, trigger := range rule.Triggers {
			hit := false
			switch trigger.Kind {
			case "always":
				hit = true
			case "onStop":
				hit = stopped
			case "onFailure":
				hit = failed
			case "textMatch":
				for _, pattern := range trigger.compiled {
					if pattern.MatchString(prose) {
						hit = true
						break
					}
				}
			}
			if !hit {
				matches = false
				break
			}
		}
		if matches {
			texts = append(texts, rule.Text)
			seen[rule.Text] = true
		}
	}
	return texts
}
