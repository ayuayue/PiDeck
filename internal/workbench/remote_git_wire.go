//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"example.com/pideck-lite/internal/remotewire"
)

// remoteGitOf maps the drawer's state to the wire.
func remoteGitOf(st gitState) remotewire.Git {
	out := remotewire.Git{IsRepo: st.IsRepo, Branch: st.Branch, Upstream: st.Upstream,
		Ahead: st.Ahead, Behind: st.Behind, Branches: append([]string(nil), st.Branches...), Error: st.Error}
	for _, f := range st.Files {
		out.Files = append(out.Files, remotewire.GitFile{Path: f.Path, Mark: f.mark(), Staged: f.staged()})
	}
	for i, c := range st.Commits {
		if i >= 20 {
			break
		}
		when := ""
		if !c.Date.IsZero() {
			when = c.Date.Format("2006-01-02")
		}
		out.Commits = append(out.Commits, remotewire.Commit{Hash: c.Hash, Short: c.Short, Subject: c.Subject, Author: c.Author, When: when})
	}
	return out
}
