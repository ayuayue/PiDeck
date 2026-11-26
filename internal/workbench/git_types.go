//go:build !js && !android && !ios

package workbench

// Repository status, history and panel state types.

import (
	"time"
)

// gitFile is one changed path in a repository.
type gitFile struct {
	Path       string
	Orig       string // where a rename or copy came from
	X, Y       byte   // index and worktree status
	Untracked  bool
	Conflicted bool
}

// staged reports whether the index holds a change of this path.
func (f gitFile) staged() bool {
	return !f.Untracked && !f.Conflicted && f.X != '.' && f.X != ' '
}

// unstaged reports whether the worktree holds a change of this path.
func (f gitFile) unstaged() bool {
	return f.Untracked || f.Conflicted || (f.Y != '.' && f.Y != ' ')
}

// mark is the one-letter status the drawer shows.
func (f gitFile) mark() string {
	if f.Conflicted {
		return "U"
	}
	if f.Untracked {
		return "?"
	}
	for _, c := range []byte{f.X, f.Y} {
		switch c {
		case 'M', 'A', 'D', 'R', 'C', 'T', 'U':
			return string(c)
		}
	}
	return "·"
}

// gitCommit is one row of the history.
type gitCommit struct {
	Hash    string
	Short   string
	Author  string
	Email   string
	Subject string
	Parents []string
	Date    time.Time
}

// gitSearch is the query box's answer over the whole repository.
type gitSearch struct {
	Query   string
	Commits []gitCommit
	Loading bool
	Error   string
}

// gitState is everything the panel draws.
type gitState struct {
	Checked bool
	Loading bool
	NotRepo bool
	IsRepo  bool

	Root   string
	Branch string
	OID    string
	// Detached says HEAD is not on a branch; Initial, that the repository
	// has no commit yet.
	Detached bool
	Initial  bool
	Upstream string
	Ahead    int
	Behind   int

	Files          []gitFile
	Commits        []gitCommit
	Branches       []string
	RemoteBranches []string
	Tags           []string
	Remotes        []gitRemote
	// Total is every commit HEAD reaches; Commits holds at most LogLimit
	// of them, so the two differ on a long history.
	Total int
	// LogLimit is how many commits were asked for.
	LogLimit int
	Error    string
}

// stagedCount and changedCount are what the drawer's headers count.
func (s gitState) stagedCount() int {
	n := 0
	for _, f := range s.Files {
		if f.staged() {
			n++
		}
	}
	return n
}

func (s gitState) changedCount() int {
	n := 0
	for _, f := range s.Files {
		if f.unstaged() {
			n++
		}
	}
	return n
}

// historyCount is the history heading's number: every commit HEAD reaches,
// not just the page that has been read.
func (s gitState) historyCount() int {
	if s.Total > 0 {
		return s.Total
	}
	return len(s.Commits)
}

// conflicts lists the paths a merge or rebase left with conflict marks.
func (s gitState) conflicts() []gitFile {
	var out []gitFile
	for _, f := range s.Files {
		if f.Conflicted {
			out = append(out, f)
		}
	}
	return out
}

// gitRemote is one named remote.
type gitRemote struct {
	Name string
	URL  string
}

// gitStashEntry is one entry of git stash list.
type gitStashEntry struct {
	Ref     string
	Subject string
}
