package main

// Checks the release and CI workflows still cover every target the app
// ships, which also keeps the YAML parseable.

import (
	"os"
	"testing"

	yaml "go.yaml.in/yaml/v3"
)

// workflowMatrix is a job's matrix include list.
type workflowMatrix struct {
	Jobs map[string]struct {
		Strategy struct {
			Matrix struct {
				Include []struct {
					OS     string `yaml:"os"`
					Target string `yaml:"target"`
					Goos   string `yaml:"goos"`
					Goarch string `yaml:"goarch"`
				} `yaml:"include"`
			} `yaml:"matrix"`
		} `yaml:"strategy"`
	} `yaml:"jobs"`
}

func readWorkflow(t *testing.T, path string) workflowMatrix {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var wf workflowMatrix
	if err := yaml.Unmarshal(raw, &wf); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return wf
}

func TestReleaseTargets(t *testing.T) {
	wf := readWorkflow(t, ".github/workflows/release.yml")
	targets := map[string]string{}
	for _, inc := range wf.Jobs["build"].Strategy.Matrix.Include {
		targets[inc.Target] = inc.OS
	}
	want := map[string]string{
		"windows_x64":   "windows-latest",
		"windows_arm64": "windows-latest",
		"macos_arm64":   "macos-latest",
		"macos_x64":     "macos-latest",
		"linux_x64":     "ubuntu-latest",
		"linux_arm64":   "ubuntu-latest",
	}
	for target, os := range want {
		if targets[target] != os {
			t.Fatalf("release target %s runs on %q, want %q (all: %v)", target, targets[target], os, targets)
		}
	}
	if len(targets) != len(want) {
		t.Fatalf("release has %d targets, want %d: %v", len(targets), len(want), targets)
	}
}

func TestCICrossTargets(t *testing.T) {
	wf := readWorkflow(t, ".github/workflows/ci.yml")
	var targets int
	for _, inc := range wf.Jobs["cross"].Strategy.Matrix.Include {
		if inc.Goos == "" || inc.Goarch == "" || inc.Target == "" {
			t.Fatalf("cross entry is incomplete: %+v", inc)
		}
		targets++
	}
	if targets != 6 {
		t.Fatalf("cross builds %d targets, want 6", targets)
	}
}
