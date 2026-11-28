//go:build !js && !android && !ios

package workbench

import (
	"encoding/base64"
	"encoding/binary"
	"runtime"
	"strings"
	"unicode/utf16"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

func shellDraft(text string) (string, bool) {
	text, ok := strings.CutPrefix(strings.TrimSpace(text), "!")
	return strings.TrimSpace(text), ok
}

// Only the interactive composer dispatches shell commands. Messages from
// the phone, integrations, templates, queues and agents are still prompts.
func (a *app) runShellDraft(s *session, script string) {
	if script == "" || len(s.images.GetUntracked()) != 0 {
		a.toast(ui.ToastInfo, "请输入要运行的命令", "命令输入不接受图片附件。")
		return
	}
	ws := a.workspaceFor(s.Target, s.WS)
	if ws == nil {
		return
	}
	if !a.projectTrusted(ws) {
		a.askTrust(ws, func() {
			if current, ok := shellDraft(s.draft.GetUntracked()); ok && current == script {
				a.runShellDraft(s, current)
			}
		})
		return
	}
	a.term.newShellCommandTab(ws.Path, ws.Target, apptext.T("运行命令"), script)
	a.term.open.Set(true)
	s.draft.Set("")
}

func shellInvocation(t target, cwd, script string) []string {
	switch t.Kind {
	case targetWSL:
		return []string{"wsl.exe", "-d", t.Distro, "--cd", cwd, "--exec", "sh", "-lc", script}
	case targetSSH:
		return []string{"ssh", "-tt", "-o", "ConnectTimeout=10", "--", t.Host,
			"cd " + shellQuote(cwd) + " && exec sh -lc " + shellQuote(script)}
	}
	if runtime.GOOS != "windows" {
		return []string{"sh", "-lc", script}
	}
	// PowerShell accepts the original UTF-16 command verbatim. Passing it
	// as a CommandLine string would re-parse quotes and trailing slashes.
	var encoded []byte
	for _, code := range utf16.Encode([]rune(script)) {
		encoded = binary.LittleEndian.AppendUint16(encoded, code)
	}
	return []string{"powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", base64.StdEncoding.EncodeToString(encoded)}
}
