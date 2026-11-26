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

// TestACPPermissionAskChoices checks the card carries the options the
// desktop draws and the values the agent accepts back.
func TestACPPermissionAskChoices(t *testing.T) {
	req := acpPermission{Title: "Run tests", ToolID: "t1", Options: []acpPermissionOption{
		{ID: "a1", Name: "Allow once", Kind: "allow_once"},
		{ID: "r1", Name: "Reject once", Kind: "reject_once"},
	}}
	ask := acpPermissionAsk(req, "acp-1-9", "Run tests")
	if ask.Method != "select" || ask.ID != "acp-1-9" {
		t.Fatalf("ask = %+v", ask)
	}
	if len(ask.Options) != 2 || ask.Options[0] != "Allow once" {
		t.Fatalf("phone options = %+v", ask.Options)
	}
	if len(ask.Choices) != 2 || ask.Choices[0].Value != "a1" || ask.Choices[0].Label != "Allow once" {
		t.Fatalf("desktop choices = %+v", ask.Choices)
	}
	// The desktop answers with the id; the phone answers with the label.
	for _, reply := range []string{"a1", "Allow once"} {
		option, ok := acpPermissionReplyOption(req, reply)
		if !ok || option.ID != "a1" {
			t.Fatalf("reply %q = %+v, %v", reply, option, ok)
		}
	}
	if _, ok := acpPermissionReplyOption(req, ""); ok {
		t.Fatal("a cancelled reply matched an option")
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
