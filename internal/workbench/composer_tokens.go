//go:build !js && !android && !ios

package workbench

import (
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

type composerToken struct{ start, end int }

// composerTokens only styles references the current session can resolve.
// Offsets are bytes into the unchanged draft; IME and native undo own text.
func composerTokens(text string, files, commands []string) []composerToken {
	var tokens []composerToken
	start := len(text) - len(strings.TrimLeftFunc(text, unicode.IsSpace))
	if start < len(text) && text[start] == '/' {
		end := start
		for end < len(text) && !strings.ContainsRune(" \t\r\n", rune(text[end])) {
			end++
		}
		name := text[start+1 : end]
		for _, command := range commands {
			if name == command && name != "" {
				tokens = append(tokens, composerToken{start, end})
				break
			}
		}
	}
	paths := append([]string(nil), files...)
	sort.Slice(paths, func(i, j int) bool { return len(paths[i]) > len(paths[j]) })
	codeRun := 0
	for i := 0; i < len(text); {
		if text[i] == '`' {
			end := i
			for end < len(text) && text[end] == '`' {
				end++
			}
			if codeRun == 0 {
				codeRun = end - i
			} else if codeRun == end-i {
				codeRun = 0
			}
			i = end
			continue
		}
		if text[i] != '@' || codeRun != 0 {
			_, width := utf8.DecodeRuneInString(text[i:])
			i += width
			continue
		}
		if i > 0 {
			prev, _ := utf8.DecodeLastRuneInString(text[:i])
			if !unicode.IsSpace(prev) && !strings.ContainsRune("([{，、", prev) {
				i++
				continue
			}
		}
		end := i
		for _, path := range paths {
			path = strings.ReplaceAll(path, `\`, "/")
			candidate := "@" + path
			if strings.ContainsAny(path, " \t") {
				candidate = "@\"" + path + "\""
			}
			if !strings.HasPrefix(text[i:], candidate) {
				continue
			}
			at := i + len(candidate)
			if at < len(text) {
				next, width := utf8.DecodeRuneInString(text[at:])
				if next == '.' && at+width < len(text) {
					after, _ := utf8.DecodeRuneInString(text[at+width:])
					if !unicode.IsSpace(after) && !strings.ContainsRune(")]},;!?，。；！？、", after) {
						continue
					}
				}
				if !unicode.IsSpace(next) && !strings.ContainsRune(",.;:!?)]}，。；：！？、", next) {
					continue
				}
			}
			end = at
			break
		}
		if end > i {
			tokens = append(tokens, composerToken{i, end})
			i = end
		} else {
			i++
		}
	}
	return tokens
}

// composerCommandNames follows the engine's own catalog, including loaded
// skill and prompt commands. It never scans the disk from a render callback.
func (a *app) composerCommandNames(cx *core.Scope, s *session) func() []string {
	names := core.NewSignalFunc(cx, []string(nil), nil)
	var loaded *piClient
	cx.Effect(func() {
		if !s.readySig.Get() || s.engine == nil || s.backend == "acp" {
			loaded = nil
			names.Set(nil)
			return
		}
		c := s.engine
		if loaded == c {
			return
		}
		loaded = c
		go func() {
			var result remotewire.Commands
			if err := c.call(map[string]any{"type": "get_commands"}, &result, 15*time.Second); err != nil {
				return
			}
			out := []string{"compact"}
			seen := map[string]bool{"compact": true}
			for _, command := range result.Commands {
				name := strings.TrimPrefix(command.Name, "/")
				if name != "" && !strings.ContainsAny(name, " \t\r\n") && !seen[name] {
					seen[name] = true
					out = append(out, name)
				}
			}
			cx.Post(func() {
				if s.engine == c && s.readySig.GetUntracked() {
					names.Set(out)
				}
			})
		}()
	})
	return func() []string {
		if s.backend == "acp" {
			var out []string
			for _, command := range s.acpCommands.Get() {
				out = append(out, strings.TrimPrefix(command.Name, "/"))
			}
			return out
		}
		return names.Get()
	}
}
