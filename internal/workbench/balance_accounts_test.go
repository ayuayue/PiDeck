//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBalanceAccountsIndependentCredentialsAndConflicts(t *testing.T) {
	dir := t.TempDir()
	if len(readBalanceAccounts(dir)) != 0 {
		t.Fatal("missing data should start empty")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		amount := 10
		if r.Header.Get("Authorization") == "Bearer second-key" {
			amount = 20
		} else if r.Header.Get("Authorization") != "Bearer first-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]int{"credit": amount}})
	}))
	defer srv.Close()
	accounts := []balanceAccount{{ID: "one", Name: "First", URL: srv.URL, Key: "first-key", Path: "data.credit", Currency: "USD"}, {ID: "two", Name: "Second", URL: srv.URL, Key: "second-key", Path: "data.credit", Currency: "USD"}}
	if err := saveBalanceAccountsIfCurrent(dir, nil, accounts); err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"$10.00", "$20.00"} {
		value, err := queryBalanceAccount(t.Context(), accounts[i])
		if err != nil || value != want {
			t.Fatalf("account %d = %q %v", i, value, err)
		}
	}
	loaded := readBalanceAccounts(dir)
	if len(loaded) != 2 || loaded[1].Key != "second-key" {
		t.Fatalf("roundtrip=%+v", loaded)
	}
	if err := saveBalanceAccountsIfCurrent(dir, nil, accounts[:1]); err == nil {
		t.Fatal("stale writer replaced accounts")
	}
	bad := accounts[0]
	bad.URL = "http://external.example/balance"
	if err := saveBalanceAccounts(dir, []balanceAccount{bad}); err == nil {
		t.Fatal("accepted cleartext external endpoint")
	}
	if err := os.WriteFile(filepath.Join(dir, balanceAccountsFile), []byte("version: 99\naccounts: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if len(readBalanceAccounts(dir)) != 0 {
		t.Fatal("unsupported document version must degrade to empty")
	}
}
