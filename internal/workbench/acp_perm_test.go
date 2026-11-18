//go:build !js && !android && !ios

package workbench

// Checks ACP permission memory.

import (
	"testing"
)

// TestACPDecisionOption checks always options are preferred.
func TestACPDecisionOption(t *testing.T) {
	req := acpPermission{Options: []acpPermissionOption{
		{ID: "a1", Name: "Allow once", Kind: "allow_once"},
		{ID: "a2", Name: "Allow always", Kind: "allow_always"},
		{ID: "r1", Name: "Reject once", Kind: "reject_once"},
		{ID: "r2", Name: "Reject always", Kind: "reject_always"},
	}}
	if got := acpDecisionOption(req, "allow"); got != "a2" {
		t.Fatalf("allow = %q", got)
	}
	if got := acpDecisionOption(req, "reject"); got != "r2" {
		t.Fatalf("reject = %q", got)
	}
	if got := acpDecisionOption(req, "maybe"); got != "" {
		t.Fatalf("unknown = %q", got)
	}
}

// TestACPOptionDecision checks only always kinds are remembered.
func TestACPOptionDecision(t *testing.T) {
	cases := map[string]string{"allow_always": "allow", "reject_always": "reject",
		"allow_once": "", "reject_once": "", "": ""}
	for kind, want := range cases {
		if got := acpOptionDecision(kind); got != want {
			t.Errorf("acpOptionDecision(%q) = %q, want %q", kind, got, want)
		}
	}
}

// TestACPPermissionMemory checks remember and clear.
func TestACPPermissionMemory(t *testing.T) {
	s := &session{}
	if got := s.acpPermissionFor("run"); got != "" {
		t.Fatalf("empty = %q", got)
	}
	s.acpRememberPermission("run", "allow")
	if got := s.acpPermissionFor("run"); got != "allow" {
		t.Fatalf("remembered = %q", got)
	}
	s.acpClearPermissions()
	if got := s.acpPermissionFor("run"); got != "" {
		t.Fatalf("after clear = %q", got)
	}
}
