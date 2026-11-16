//go:build !js && !android && !ios

package main

// The Git panel's backend. It reads a project's repository with the git
// command and runs the operations the drawer asks for: on this machine, in
// a WSL distribution or on an SSH host, the same way targets run pi.
// Everything here runs off the UI thread and posts a new state back.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/base/commitgraph"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
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

// gitRepo reads one project's repository and runs its operations.
type gitRepo struct {
	cx *core.Scope

	mu     sync.Mutex
	path   string
	target target

	state    *core.Signal[gitState]
	history  *commitgraph.History
	logQuery *core.Signal[string]
	msg      *core.Signal[string]
	amend    *core.Signal[bool]
	busy     *core.Signal[string]
	err      *core.Signal[string]

	// onResult lets the app toast an action's outcome.
	onResult func(label string, err error)

	// logLimit grows as the history's "more" is pressed.
	logLimit int

	seq     int
	working bool
	running bool
	pending bool
}

// newGitRepo builds the panel's state.
func newGitRepo(cx *core.Scope) *gitRepo {
	g := &gitRepo{
		cx:       cx,
		state:    core.NewSignalFunc(cx, gitState{Checked: true}, nil),
		logQuery: core.NewSignal(cx, ""),
		logLimit: 50,
		msg:      core.NewSignal(cx, ""),
		amend:    core.NewSignal(cx, false),
		busy:     core.NewSignal(cx, ""),
		err:      core.NewSignal(cx, ""),
	}
	g.history = commitgraph.NewHistory(cx, func() []commitgraph.Commit {
		st := g.state.Get()
		out := make([]commitgraph.Commit, 0, len(st.Commits))
		for _, c := range st.Commits {
			out = append(out, commitgraph.Commit{Hash: c.Hash, Parents: c.Parents})
		}
		return out
	}, nil)
	return g
}

// repo is the repository commands run in.
func (r *gitRepo) repo() (target, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.target, r.path
}

// attach points the panel at a workspace, if it is another one, and reads
// its repository.
func (r *gitRepo) attach(ws *workspace) bool {
	path, t := "", localTarget
	if ws != nil {
		path, t = ws.Path, ws.Target
	}
	r.mu.Lock()
	same := path == r.path && t.key() == r.target.key()
	if !same {
		r.path, r.target = path, t
	}
	r.mu.Unlock()
	if same {
		return false
	}
	r.seq++
	r.working, r.running, r.pending = false, false, false
	r.logLimit = 50
	r.logQuery.Set("")
	r.err.Set("")
	r.busy.Set("")
	r.msg.Set("")
	r.amend.Set(false)
	if path == "" {
		r.state.Set(gitState{Checked: true})
		return true
	}
	r.state.Set(gitState{Loading: true})
	r.refreshAll()
	return true
}

// refreshAll reads the status, the history and the branches.
func (r *gitRepo) refreshAll() {
	t, path := r.repo()
	if path == "" {
		return
	}
	if r.working {
		r.pending = true
		return
	}
	r.working = true
	r.state.Update(func(s gitState) gitState { s.Loading = true; return s })
	seq := r.seq
	go func() {
		st := readGitState(t, path, r.logLimit)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.working = false
			st.Loading = false
			st.Checked = true
			r.state.Set(st)
			if r.pending {
				r.pending = false
				r.refreshAll()
			}
		})
	}()
}

// loadMore asks for another page of history.
func (r *gitRepo) loadMore() {
	if r.logLimit >= 500 {
		return
	}
	r.logLimit += 50
	r.refreshAll()
}

// poll reads the status alone, for the drawer's periodic refresh.
func (r *gitRepo) poll() {
	t, path := r.repo()
	if path == "" || r.working || r.running {
		return
	}
	cur := r.state.GetUntracked()
	if cur.NotRepo {
		return
	}
	r.working = true
	seq := r.seq
	go func() {
		st, err := readGitStatus(t, path)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.working = false
			old := r.state.GetUntracked()
			switch {
			case err != nil:
				old.Error, old.Loading, old.Checked = err.Error(), false, true
				r.state.Set(old)
			case st.NotRepo:
				st.Checked, st.Loading = true, false
				r.state.Set(st)
			default:
				st.Root, st.Commits, st.Branches = old.Root, old.Commits, old.Branches
				st.Checked, st.Loading = true, false
				r.state.Set(st)
			}
			if r.pending {
				r.pending = false
				r.refreshAll()
			}
		})
	}()
}

// gitRunner is an action's repository: commands stay on the project that
// asked for them even if the drawer moves to another while they run.
type gitRunner struct {
	t    target
	path string
}

// exec runs one git command in the runner's repository.
func (g gitRunner) exec(timeout time.Duration, args ...string) (string, error) {
	out, stderr, code, err := gitRun(g.t, g.path, timeout, args...)
	if err != nil {
		return out, err
	}
	if code != 0 {
		return out, errors.New(gitMessage(stderr, code))
	}
	return out, nil
}

// execDiff reads a diff, where exit code 1 means the texts differ.
func (g gitRunner) execDiff(timeout time.Duration, args ...string) (string, error) {
	out, stderr, code, err := gitRun(g.t, g.path, timeout, args...)
	if err != nil {
		return "", err
	}
	if code > 1 {
		return "", errors.New(gitMessage(stderr, code))
	}
	return out, nil
}

// runner binds a command to the repository attached now.
func (r *gitRepo) runner() gitRunner {
	t, path := r.repo()
	return gitRunner{t: t, path: path}
}

// run performs an action off the UI thread, then rereads the repository.
func (r *gitRepo) run(label string, fn func(g gitRunner) error, done func(error)) {
	t, path := r.repo()
	if path == "" || r.running {
		return
	}
	r.running = true
	r.err.Set("")
	r.busy.Set(label)
	seq := r.seq
	go func() {
		err := fn(gitRunner{t: t, path: path})
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.running = false
			r.busy.Set("")
			if err != nil {
				r.err.Set(label + "失败：" + err.Error())
			}
			if done != nil {
				done(err)
			}
			if r.onResult != nil {
				r.onResult(label, err)
			}
			r.refreshAll()
		})
	}()
}

// readGitState reads a repository's status, root, history and branches.
func readGitState(t target, dir string, logLimit int) gitState {
	if logLimit <= 0 {
		logLimit = 50
	}
	st, err := readGitStatus(t, dir)
	if err != nil {
		return gitState{Checked: true, Error: err.Error()}
	}
	if st.NotRepo {
		return st
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "rev-parse", "--show-toplevel"); err == nil && code == 0 {
		st.Root = strings.TrimSpace(out)
	}
	if out, _, code, err := gitRun(t, dir, 30*time.Second, "--no-pager", "log", "-n", fmt.Sprint(logLimit), "--date=iso-strict",
		"--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e"); err == nil && code == 0 {
		st.Commits = parseGitLog(out)
		st.LogLimit = logLimit
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "branch", "--list", "--format=%(refname:short)"); err == nil && code == 0 {
		st.Branches = parseGitBranches(out)
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "branch", "-r", "--format=%(refname:short)"); err == nil && code == 0 {
		st.RemoteBranches = parseRemoteBranches(out)
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "tag", "--sort=-creatordate"); err == nil && code == 0 {
		st.Tags = parseGitTags(out)
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "remote", "-v"); err == nil && code == 0 {
		st.Remotes = parseGitRemotes(out)
	}
	return st
}

// readUnpushedCommits lists the commits the upstream branch does not have.
func readUnpushedCommits(t target, dir string) ([]gitCommit, error) {
	out, stderr, code, err := gitRun(t, dir, 30*time.Second, "--no-pager", "log", "-n", "100", "--date=iso-strict",
		"--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e", "@{u}..HEAD")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, errors.New(gitMessage(stderr, code))
	}
	return parseGitLog(out), nil
}

// diffPathValue reads the path after "+++ ": Git may quote it and escape
// non-ASCII bytes, and may follow it with a tab and a timestamp.
func diffPathValue(line string) string {
	v := strings.TrimPrefix(line, "+++ ")
	if strings.HasPrefix(v, "\"") {
		for i := 1; i < len(v); i++ {
			if v[i] == '\\' {
				i++
				continue
			}
			if v[i] == '"' {
				return unquoteGitPath(v[1:i])
			}
		}
		return ""
	}
	if i := strings.IndexByte(v, '\t'); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

// unquoteGitPath decodes the C-style escapes Git writes for unusual names.
func unquoteGitPath(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 >= len(s) {
			b.WriteByte(c)
			continue
		}
		i++
		switch s[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case '\\', '"':
			b.WriteByte(s[i])
		case '0', '1', '2', '3', '4', '5', '6', '7':
			v := int(s[i] - '0')
			for n := 1; n < 3 && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '7'; n++ {
				i++
				v = v*8 + int(s[i]-'0')
			}
			b.WriteByte(byte(v))
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// diffFiles lists the paths a patch touches, in order and once each.
func diffFiles(patch string) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(patch, "\n") {
		if !strings.HasPrefix(line, "+++ ") {
			continue
		}
		path := strings.TrimPrefix(diffPathValue(line), "b/")
		if path == "" || path == "/dev/null" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
		if len(out) >= 50 {
			break
		}
	}
	return out
}

// blameRange is a run of lines last changed by one commit.
type blameRange struct {
	Hash    string
	Author  string
	When    time.Time
	Subject string
	Start   int // 1-based, inclusive
	End     int
}

// short is the hash as a row shows it.
func (b blameRange) short() string {
	if len(b.Hash) > 7 {
		return b.Hash[:7]
	}
	return b.Hash
}

// parseGitBlame reads the porcelain lines git blame prints, folding
// consecutive lines of one commit into a range.
func parseGitBlame(out string) []blameRange {
	var ranges []blameRange
	var cur blameRange
	lineNo := 0
	hash := ""
	for _, line := range strings.Split(out, "\n") {
		if len(line) > 41 && line[40] == ' ' && isHexHash(line[:40]) {
			fields := strings.Fields(line)
			if len(fields) >= 3 {
				if n, err := strconv.Atoi(fields[2]); err == nil {
					lineNo = n
					hash = fields[0]
					cur.Hash = hash
					continue
				}
			}
		}
		switch {
		case strings.HasPrefix(line, "author "):
			cur.Author = strings.TrimPrefix(line, "author ")
		case strings.HasPrefix(line, "author-time "):
			if sec, err := strconv.ParseInt(strings.TrimPrefix(line, "author-time "), 10, 64); err == nil {
				cur.When = time.Unix(sec, 0)
			}
		case strings.HasPrefix(line, "summary "):
			cur.Subject = strings.TrimPrefix(line, "summary ")
		case strings.HasPrefix(line, "	"):
			cur.Start, cur.End = lineNo, lineNo
			if n := len(ranges); n > 0 && ranges[n-1].Hash == cur.Hash && ranges[n-1].End == lineNo-1 {
				ranges[n-1].End = lineNo
			} else {
				ranges = append(ranges, cur)
			}
			cur = blameRange{}
		}
	}
	return ranges
}

// isHexHash reports whether a string is a full commit id.
func isHexHash(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// readFileBlame attributes a file's lines, at most the first 2000 of them.
func readFileBlame(t target, dir, path string) ([]blameRange, error) {
	out, stderr, code, err := gitRun(t, dir, 90*time.Second, "blame", "--line-porcelain", "-L", "1,2000", "--", path)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, errors.New(gitMessage(stderr, code))
	}
	return parseGitBlame(out), nil
}

// readFileHistory lists the commits that touched one path, newest first.
func readFileHistory(t target, dir, path string, limit int) ([]gitCommit, error) {
	if limit <= 0 {
		limit = 50
	}
	out, stderr, code, err := gitRun(t, dir, 30*time.Second, "--no-pager", "log", "-n", strconv.Itoa(limit), "--date=iso-strict",
		"--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e", "--", path)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, errors.New(gitMessage(stderr, code))
	}
	return parseGitLog(out), nil
}

// gitRemote is one named remote.
type gitRemote struct {
	Name string
	URL  string
}

// parseGitRemotes reads remote -v, one row per name.
func parseGitRemotes(out string) []gitRemote {
	var list []gitRemote
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || seen[fields[0]] {
			continue
		}
		seen[fields[0]] = true
		list = append(list, gitRemote{Name: fields[0], URL: fields[1]})
		if len(list) >= 20 {
			break
		}
	}
	return list
}

// parseGitTags reads a tag list, newest first, capped.
func parseGitTags(out string) []string {
	var tags []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		tags = append(tags, line)
		if len(tags) >= 100 {
			break
		}
	}
	return tags
}

// readGitStatus reads the status alone.
func readGitStatus(t target, dir string) (gitState, error) {
	out, stderr, code, err := gitRun(t, dir, 20*time.Second,
		"-c", "core.quotepath=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
	if err != nil {
		return gitState{}, err
	}
	if code != 0 {
		msg := gitMessage(stderr, code)
		if isNotGitRepo(msg) {
			return gitState{NotRepo: true}, nil
		}
		return gitState{}, errors.New(msg)
	}
	st := parseGitStatus(out)
	st.IsRepo = true
	return st, nil
}

// parseGitStatus reads porcelain v2's NUL-separated records.
func parseGitStatus(out string) gitState {
	st := gitState{IsRepo: true}
	records := strings.Split(out, "\x00")
	for i := 0; i < len(records); i++ {
		rec := records[i]
		if rec == "" {
			continue
		}
		switch rec[0] {
		case '#':
			fields := strings.SplitN(rec, " ", 3)
			if len(fields) < 3 {
				continue
			}
			key, value := fields[1], fields[2]
			switch key {
			case "branch.oid":
				if value == "(initial)" {
					st.Initial = true
				} else {
					st.OID = value
				}
			case "branch.head":
				if value == "(detached)" {
					st.Detached = true
				} else {
					st.Branch = value
				}
			case "branch.upstream":
				st.Upstream = value
			case "branch.ab":
				for _, part := range strings.Fields(value) {
					if n, err := strconv.Atoi(part[1:]); err == nil {
						switch part[0] {
						case '+':
							st.Ahead = n
						case '-':
							st.Behind = n
						}
					}
				}
			}
		case '1':
			parts := strings.SplitN(rec, " ", 9)
			if len(parts) == 9 && len(parts[1]) == 2 {
				st.Files = append(st.Files, gitFile{Path: parts[8], X: parts[1][0], Y: parts[1][1]})
			}
		case '2':
			parts := strings.SplitN(rec, " ", 10)
			if len(parts) == 10 && len(parts[1]) == 2 {
				f := gitFile{Path: parts[9], X: parts[1][0], Y: parts[1][1]}
				if i+1 < len(records) {
					f.Orig = records[i+1]
					i++
				}
				st.Files = append(st.Files, f)
			}
		case 'u':
			parts := strings.SplitN(rec, " ", 11)
			if len(parts) == 11 && len(parts[1]) == 2 {
				st.Files = append(st.Files, gitFile{Path: parts[10], X: parts[1][0], Y: parts[1][1], Conflicted: true})
			}
		case '?':
			if len(rec) > 2 {
				st.Files = append(st.Files, gitFile{Path: rec[2:], Untracked: true, X: '?', Y: '?'})
			}
		}
	}
	sort.SliceStable(st.Files, func(i, j int) bool {
		return strings.ToLower(st.Files[i].Path) < strings.ToLower(st.Files[j].Path)
	})
	return st
}

// parseGitLog reads the record-separated log.
func parseGitLog(out string) []gitCommit {
	var commits []gitCommit
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		parts := strings.SplitN(rec, "\x1f", 7)
		if len(parts) < 6 {
			continue
		}
		c := gitCommit{Hash: parts[0], Short: parts[1], Author: parts[2], Email: parts[3], Subject: parts[5]}
		if len(parts) == 7 && strings.TrimSpace(parts[6]) != "" {
			c.Parents = strings.Fields(parts[6])
		}
		if t, err := time.Parse(time.RFC3339, parts[4]); err == nil {
			c.Date = t
		}
		commits = append(commits, c)
	}
	return commits
}

// parseRemoteBranches reads remote branches, leaving out the symbolic HEAD.
func parseRemoteBranches(out string) []string {
	var branches []string
	for _, line := range strings.Split(out, "\n") {
		name := strings.TrimSpace(line)
		if name == "" || strings.HasSuffix(name, "/HEAD") || name == "HEAD" {
			continue
		}
		branches = append(branches, name)
	}
	return branches
}

// parseGitBranches reads one branch name a line.
func parseGitBranches(out string) []string {
	var branches []string
	for _, line := range strings.Split(out, "\n") {
		name := strings.TrimSpace(line)
		if name != "" {
			branches = append(branches, name)
		}
	}
	return branches
}

// gitCommand builds the command that runs git on a target.
func gitCommand(ctx context.Context, t target, dir string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	switch t.Kind {
	case targetWSL:
		all := append([]string{"-d", t.Distro, "--cd", dir, "--", "env",
			"LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "GIT_EDITOR=true", "git"}, args...)
		cmd = exec.CommandContext(ctx, "wsl.exe", all...)
	case targetSSH:
		script := "cd " + shellQuote(dir) + " && LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat GIT_EDITOR=true git " + shellJoin(args)
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", t.Host, script)
	default:
		cmd = exec.CommandContext(ctx, "git", args...)
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "GIT_EDITOR=true", "LC_ALL=C")
	cmd.Env = append(cmd.Env, appProxy.env()...)
	hideWindow(cmd)
	return cmd
}

// gitRun runs one git command and reports its output and exit code.
func gitRun(t target, dir string, timeout time.Duration, args ...string) (stdout, stderr string, code int, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := gitCommand(ctx, t, dir, args...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err = cmd.Run()
	switch {
	case err == nil:
		return out.String(), errOut.String(), 0, nil
	case ctx.Err() == context.DeadlineExceeded:
		return out.String(), errOut.String(), -1, fmt.Errorf("git 超过 %s 没有结束", timeout)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return out.String(), errOut.String(), exit.ExitCode(), nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return out.String(), errOut.String(), -1, errors.New("找不到 git 命令，请先安装 Git")
	}
	return out.String(), errOut.String(), -1, err
}

// gitMessage is a git command's failure as one line.
func gitMessage(stderr string, code int) string {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = fmt.Sprintf("git 退出码 %d", code)
	}
	return firstLine(msg, 400)
}

// isNotGitRepo reports whether git said the folder is no repository.
func isNotGitRepo(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "not a git repository") || strings.Contains(lower, "not a git repo")
}

// fileMarks maps every changed file's absolute path to its status, for
// the file tree. Paths are relative to the repository root, which may be
// above the workspace.
func (a *app) fileMarks() map[string]gitFile {
	if a.git == nil {
		return nil
	}
	st := a.git.state.Get()
	if !st.IsRepo || st.Root == "" {
		return nil
	}
	out := make(map[string]gitFile, len(st.Files))
	for _, f := range st.Files {
		p := filepath.Clean(filepath.Join(st.Root, filepath.FromSlash(f.Path)))
		out[p] = f
	}
	return out
}

// changedDirs are the folders above a changed file, so a collapsed
// folder can show that something under it changed.
func changedDirs(marks map[string]gitFile, root string) map[string]bool {
	if len(marks) == 0 {
		return nil
	}
	root = filepath.Clean(root)
	out := map[string]bool{}
	for path := range marks {
		dir := filepath.Dir(path)
		for {
			out[dir] = true
			if dir == root {
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return out
}

// gitMarkColor is a status letter's tone.
func gitMarkColor(mark string) string {
	switch mark {
	case "A":
		return "up"
	case "D", "U":
		return "down"
	case "M", "R", "C", "T":
		return "warn"
	}
	return "faint"
}

// gitStashEntry is one entry of git stash list.
type gitStashEntry struct {
	Ref     string
	Subject string
}

// listGitStashes reads the stash list.
func listGitStashes(g gitRunner) ([]gitStashEntry, error) {
	out, err := g.exec(30*time.Second, "stash", "list", "--format=%gd%x09%gs")
	if err != nil {
		return nil, err
	}
	var list []gitStashEntry
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		ref, subject, _ := strings.Cut(line, "\t")
		if ref == "" {
			continue
		}
		list = append(list, gitStashEntry{Ref: ref, Subject: subject})
		if len(list) >= 100 {
			break
		}
	}
	return list, nil
}

// commitWebURL is the web page of a commit, from a remote's URL.
func commitWebURL(remote, hash string) (string, error) {
	remote = strings.TrimSpace(remote)
	hash = strings.TrimSpace(hash)
	if remote == "" {
		return "", errors.New("这个仓库没有 origin 远端")
	}
	if hash == "" {
		return "", errors.New("没有提交哈希")
	}
	host, path := "", ""
	switch {
	case strings.HasPrefix(remote, "http://") || strings.HasPrefix(remote, "https://"):
		u, err := url.Parse(remote)
		if err != nil || u.Host == "" {
			return "", errors.New("远端地址看不懂：" + remote)
		}
		host, path = u.Host, u.Path
	case strings.HasPrefix(remote, "ssh://"):
		u, err := url.Parse(remote)
		if err != nil || u.Hostname() == "" {
			return "", errors.New("远端地址看不懂：" + remote)
		}
		host, path = u.Hostname(), u.Path
	case strings.HasPrefix(remote, "git@"):
		rest := strings.TrimPrefix(remote, "git@")
		h, p, ok := strings.Cut(rest, ":")
		if !ok || h == "" || p == "" {
			return "", errors.New("远端地址看不懂：" + remote)
		}
		host, path = h, p
	default:
		return "", errors.New("远端不是常见地址：" + remote)
	}
	path = strings.Trim(strings.TrimSuffix(path, ".git"), "/")
	if host == "" || path == "" {
		return "", errors.New("远端地址缺主机或仓库：" + remote)
	}
	lower := strings.ToLower(host)
	switch {
	case strings.Contains(lower, "gitlab"):
		return "https://" + host + "/" + path + "/-/commit/" + hash, nil
	case strings.Contains(lower, "bitbucket"):
		return "https://" + host + "/" + path + "/commits/" + hash, nil
	}
	return "https://" + host + "/" + path + "/commit/" + hash, nil
}

// openCommitInBrowser opens a commit on its remote's web page.
func (a *app) openCommitInBrowser(c gitCommit) {
	if a.gitPath() == "" {
		return
	}
	runner := a.git.runner()
	go func() {
		out, err := runner.exec(20*time.Second, "remote", "get-url", "origin")
		var link string
		if err == nil {
			link, err = commitWebURL(strings.TrimSpace(out), c.Hash)
		}
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "打不开提交链接", err.Error())
				return
			}
			a.cx.OpenURL(link, nil)
		})
	}()
}
