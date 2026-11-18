//go:build !js && !android && !ios

package workbench

// Read and parse repository status, branches, tags and remotes.

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

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
