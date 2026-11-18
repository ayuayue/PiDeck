//go:build !js && !android && !ios

package workbench

// Parse changed paths and line attribution from Git output.

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

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
