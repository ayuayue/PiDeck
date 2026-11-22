//go:build !js && !android && !ios

package workbench

// pi's package commands: list, install, remove and update. The app runs pi's
// own CLI; pi owns settings.json and the package cache, so the store never
// edits those files itself.

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"example.com/pideck-lite/internal/viewkit"
)

// piPackage is one installed package as `pi list` reports it.
type piPackage struct {
	Source string
	Path   string
	Scope  string // "user" or "project"
}

// piPackageSourcePattern is what may reach `pi install|remove`. Every form pi
// accepts (npm:, git:, https:, file:, a local path) fits; whitespace, quotes
// and cmd.exe expansion characters do not, and are refused.
var piPackageSourcePattern = regexp.MustCompile(`^[A-Za-z0-9@._:/\\+~-]+$`)

// piGitSourcePattern is the only git form the catalog may install.
var piGitSourcePattern = regexp.MustCompile(`^git:github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// validPiPackageSource reports whether source is safe to pass to pi.
func validPiPackageSource(source string) bool {
	return source != "" && len(source) <= 512 && piPackageSourcePattern.MatchString(source)
}

// validPiInstallSource narrows installs to npm names or GitHub repos from
// the catalog.
func validPiInstallSource(source string) bool {
	if piGitSourcePattern.MatchString(source) {
		return true
	}
	name, ok := strings.CutPrefix(source, "npm:")
	if !ok || name == "" || len(name) > 214 {
		return false
	}
	for _, part := range strings.Split(strings.TrimPrefix(name, "@"), "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return validPiPackageSource(source)
}

// parsePiList reads `pi list`'s two-line entries. A source line is indented
// two spaces, its install path four; a section header sets the scope.
func parsePiList(raw string) []piPackage {
	var out []piPackage
	scope := "user"
	last := -1
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trimmed, "User packages:"):
			scope, last = "user", -1
			continue
		case strings.HasPrefix(trimmed, "Project packages:"):
			scope, last = "project", -1
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent >= 4 {
			if last >= 0 {
				out[last].Path = trimmed
			}
			continue
		}
		if indent < 2 {
			continue
		}
		source := strings.TrimSuffix(trimmed, " (filtered)")
		if source == "" {
			continue
		}
		out = append(out, piPackage{Source: source, Scope: scope})
		last = len(out) - 1
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i].Source) < strings.ToLower(out[j].Source)
	})
	return out
}

// readPiPackages asks pi for its installed packages.
func readPiPackages(piPath, dir string) ([]piPackage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := piCommand(ctx, piPath, "list")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), agentProxy.env()...)
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return nil, err
	}
	return parsePiList(string(out)), nil
}

// runPiPackageCommand runs one install/remove/update and returns pi's own
// first error line, which is more useful than the exit status.
func runPiPackageCommand(ctx context.Context, piPath, dir string, args ...string) error {
	cmd := piCommand(ctx, piPath, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), agentProxy.env()...)
	log := &ringBuffer{limit: 16 << 10}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if detail := viewkit.FirstLine(strings.TrimSpace(log.String()), 240); detail != "" {
			return fmt.Errorf("%s", detail)
		}
		return err
	}
	return nil
}
