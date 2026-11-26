package client

// When a poll brings back what the page already holds, nothing may be
// redrawn. The phone polls every second or two, and a page rebuilt on every
// poll flickers and drops a tap that landed mid-rebuild. A poll decodes the
// wire afresh, so the same line arrives as a new Tool pointer and the same
// question as a new Ask: signals compare with these instead of by identity.

import (
	"slices"

	"example.com/pideck-v2/internal/remotewire"
)

// sameMessages says two transcripts carry the same lines.
func sameMessages(a, b []remotewire.Message) bool {
	return slices.EqualFunc(a, b, func(x, y remotewire.Message) bool {
		if x.Role != y.Role || x.Text != y.Text || x.Turn != y.Turn || x.Image != y.Image {
			return false
		}
		if x.Tool == nil || y.Tool == nil {
			return x.Tool == nil && y.Tool == nil
		}
		// A tool line is all scalars, so its value is its content.
		return *x.Tool == *y.Tool
	})
}

// sameAsk says two pending questions are the same one.
func sameAsk(a, b *remotewire.Ask) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if a.Method != b.Method || a.Title != b.Title || a.Message != b.Message || a.Review != b.Review {
		return false
	}
	if !slices.Equal(a.Options, b.Options) || len(a.Questions) != len(b.Questions) {
		return false
	}
	for i, q := range a.Questions {
		o := b.Questions[i]
		if q.ID != o.ID || q.Type != o.Type || q.Question != o.Question || q.AllowOther != o.AllowOther ||
			q.Placeholder != o.Placeholder || q.Prefill != o.Prefill || !slices.Equal(q.Options, o.Options) {
			return false
		}
	}
	return true
}

// sameSnapshot says the desktop's projects and sessions are the ones the rail
// already lists.
func sameSnapshot(a, b remotewire.Snapshot) bool {
	if a.Name != b.Name || a.Version != b.Version || a.Host != b.Host || len(a.Projects) != len(b.Projects) {
		return false
	}
	for i, p := range a.Projects {
		q := b.Projects[i]
		if p.Path != q.Path || p.Name != q.Name || p.Target != q.Target || p.Root != q.Root ||
			len(p.Sessions) != len(q.Sessions) {
			return false
		}
		for j, s := range p.Sessions {
			t := q.Sessions[j]
			if s.ID != t.ID || s.ParentID != t.ParentID || s.Title != t.Title || s.Status != t.Status || s.Updated != t.Updated ||
				s.External != t.External || s.Pinned != t.Pinned || s.Running != t.Running ||
				s.Mode != t.Mode || s.Tokens != t.Tokens || s.Context != t.Context ||
				s.ContextWindow != t.ContextWindow || s.Cost != t.Cost || !sameAsk(s.Ask, t.Ask) {
				return false
			}
		}
	}
	return true
}
