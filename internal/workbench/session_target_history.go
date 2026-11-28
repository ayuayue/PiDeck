//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"slices"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
)

func (a *app) scanTargetSessions(ws *workspace) {
	ws.PiLoading.Set(true)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 14*time.Second)
		defer cancel()
		metas, err := targetSessionMetas(ctx, ws.Target, ws.Path)
		a.cx.Post(func() {
			ws.PiLoading.Set(false)
			if a.workspaceFor(ws.Target, ws.Path) != ws {
				return
			}
			// A failed background scan can be retried by reopening the
			// project. Keep the old rows while the target is unreachable.
			if err != nil {
				a.diagf("warn", "could not list sessions on remote project")
				return
			}
			ws.piLoaded = true
			list := slices.Clone(ws.Sessions.GetUntracked())
			seen := make(map[string]bool, len(list))
			for _, s := range list {
				seen[s.ID] = true
			}
			for _, m := range metas {
				if existing := a.byID[m.ID]; existing != nil && (existing.Target != ws.Target || existing.WS != ws.Path) {
					continue
				}
				if seen[m.ID] {
					if s := a.byID[m.ID]; s != nil && s.File == "" && !s.starting && !s.deleting {
						s.File = m.File
					}
					continue
				}
				if title := a.cfg.Titles[m.ID]; title != "" {
					m.Title = title
				}
				list = append(list, a.makeSession(m, ws.Target))
			}
			ws.Sessions.Set(list)
			a.restoreTargetTabs()
		})
	}()
}

func (a *app) restoreTargetTabs() {
	if len(a.pendingTabs) == 0 {
		return
	}
	var active *session
	for _, id := range a.pendingTabs {
		if s := a.byID[id]; s != nil {
			a.addTab(id)
			if id == a.pendingActive {
				active = s
			}
		}
	}
	a.pendingTabs = slices.DeleteFunc(a.pendingTabs, func(id string) bool { return a.byID[id] != nil })
	if active != nil {
		a.selectSession(active)
	}
}

func targetSessionMetas(ctx context.Context, t target, cwd string) ([]sessionMeta, error) {
	// Read only session headers. No transcript or agent process is needed
	// to populate a project's sidebar.
	cmd, err := t.workspaceCommand(ctx, cwd, `
dir="`+remoteDir+`"
[ -d "$dir" ] || exit 0
[ ! -L "$HOME/.pideck-v2" ] && [ ! -L "$dir" ] || exit 42
find "$dir" -type f -name '*.jsonl' -exec sh -c '
  for file do
    printf "%s\000" "$file"
    head -c 16384 "$file" | head -n 1
    printf "\000"
  done
' sh {} +
`)
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	bounded := &io.LimitedReader{R: stdout, N: 12 << 20}
	r := bufio.NewReader(bounded)
	var out []sessionMeta
	var readErr error
	for len(out) < 500 {
		var file, header string
		file, readErr = r.ReadString(0)
		if readErr != nil {
			break
		}
		header, readErr = r.ReadString(0)
		if readErr != nil {
			break
		}
		file = strings.TrimSuffix(file, "\x00")
		var meta struct {
			Type          string    `json:"type"`
			ID            string    `json:"id"`
			Cwd           string    `json:"cwd"`
			ParentSession string    `json:"parentSession"`
			Time          time.Time `json:"timestamp"`
		}
		if !validTargetSessionFile(file) ||
			json.Unmarshal([]byte(strings.TrimSuffix(header, "\x00")), &meta) != nil || meta.Type != "session" || meta.ID == "" ||
			path.Clean(meta.Cwd) != path.Clean(cwd) {
			continue
		}
		out = append(out, sessionMeta{ID: meta.ID, File: file, Cwd: cwd, Updated: meta.Time, Target: t.key(),
			Parent: strings.TrimSpace(meta.ParentSession), Title: apptext.T("未命名会话")})
	}
	_ = stdout.Close()
	if len(out) >= 500 || bounded.N == 0 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	} else if err := cmd.Wait(); err != nil {
		return nil, err
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return nil, readErr
	}
	return out, nil
}

func targetHistoryMessages(t target, file string) ([]piMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	if !validTargetSessionFile(file) {
		return nil, errFilePath
	}
	const limit = 32 << 20
	cmd, err := t.workspaceCommand(ctx, "/", targetSessionGuard+`head -c 33554433 "$file"`, file)
	if err != nil {
		return nil, err
	}
	r, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	data, err := readTextFile(r, limit)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	if err := targetFileError(cmd.Wait()); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var msgs []piMessage
	for line := range bytes.SplitSeq(data, []byte("\n")) {
		if msg, ok := historyLineMessage(line); ok {
			msgs = append(msgs, msg)
		}
	}
	return msgs, nil
}

func validTargetSessionFile(file string) bool {
	return strings.HasPrefix(file, "/") && path.Clean(file) == file &&
		strings.Contains(file, "/.pideck-v2/sessions/") && path.Ext(file) == ".jsonl" &&
		!strings.ContainsAny(file, "\x00\r\n")
}

const targetSessionGuard = `
dir="` + remoteDir + `"
file="$2"
case "$file" in "$dir"/*.jsonl) ;; *) exit 42 ;; esac
[ ! -L "$HOME/.pideck-v2" ] && [ ! -L "$dir" ] || exit 42
parent="${file%/*}"
while [ "$parent" != "$dir" ]; do
  [ ! -L "$parent" ] || exit 42
  parent="${parent%/*}"
done
[ ! -L "$file" ] || exit 42
[ -f "$file" ] || exit 41
`
