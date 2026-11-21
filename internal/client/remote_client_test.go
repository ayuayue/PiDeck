package client

import "testing"

func TestNewRemoteClientTokenLinkFallback(t *testing.T) {
	const address = "http://desk.example:8787/?token=link-token"
	tests := []struct {
		name  string
		token string
		want  string
	}{
		{name: "link fills empty token", want: "link-token"},
		{name: "entered token overrides link", token: "new-token", want: "new-token"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, token, err := newRemoteClient(address, tt.token)
			if err != nil {
				t.Fatalf("newRemoteClient: %v", err)
			}
			defer client.close()
			if token != tt.want {
				t.Fatalf("returned token = %q, want %q", token, tt.want)
			}
			if client.token != tt.want {
				t.Fatalf("client token = %q, want %q", client.token, tt.want)
			}
		})
	}
}
