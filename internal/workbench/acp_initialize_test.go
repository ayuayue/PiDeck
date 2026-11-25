package workbench

import "testing"

func TestACPInitializeParamsOmitHostIdentity(t *testing.T) {
	params := acpInitializeParams()
	if _, ok := params["clientInfo"]; ok {
		t.Fatal("ACP initialize must not send PiDeck identity to the agent")
	}
	if params["protocolVersion"] != 1 {
		t.Fatalf("protocolVersion = %v, want 1", params["protocolVersion"])
	}
	if _, ok := params["clientCapabilities"].(map[string]any); !ok {
		t.Fatalf("clientCapabilities = %T, want map[string]any", params["clientCapabilities"])
	}
}
