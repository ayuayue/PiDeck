//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"
)

const balanceAccountsFile = "balance-accounts.yaml"

var balanceAccountsMu sync.Mutex

func saveBalanceAccountsIfCurrent(dir string, old, next []balanceAccount) error {
	balanceAccountsMu.Lock()
	defer balanceAccountsMu.Unlock()
	if !slices.Equal(readBalanceAccounts(dir), old) {
		return errors.New("balance accounts changed; reopen this page before saving")
	}
	return saveBalanceAccounts(dir, next)
}

type balanceAccount struct{ ID, Name, URL, Key, Path, Currency string }

func (a balanceAccount) valid() bool {
	u, err := url.Parse(a.URL)
	return err == nil && u.Host != "" && u.User == nil && u.Fragment == "" && (u.Scheme == "https" || (u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) &&
		marketID.MatchString(a.ID) && len(a.ID) <= 80 && strings.TrimSpace(a.Name) != "" && len(a.Name) <= 160 && len(a.URL) <= 2048 && len(a.Key) <= 8192 && !strings.ContainsAny(a.Key, "\r\n\x00") && len(a.Path) <= 256 && len(a.Currency) <= 16
}

func readBalanceAccounts(dir string) []balanceAccount {
	f, err := os.Open(filepath.Join(dir, balanceAccountsFile))
	if err != nil {
		return nil
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (256<<10)+1))
	if err != nil || len(raw) > 256<<10 {
		return nil
	}
	var doc struct {
		Version  int
		Accounts []balanceAccount
	}
	if yaml.Unmarshal(raw, &doc) != nil || doc.Version != 1 {
		return nil
	}
	var out []balanceAccount
	seen := map[string]bool{}
	for _, a := range doc.Accounts {
		if a.valid() && !seen[a.ID] {
			out = append(out, a)
			seen[a.ID] = true
		}
		if len(out) == 32 {
			break
		}
	}
	return out
}

func saveBalanceAccounts(dir string, accounts []balanceAccount) error {
	if len(accounts) > 32 {
		return errors.New("too many balance accounts")
	}
	seen := map[string]bool{}
	for _, a := range accounts {
		if !a.valid() || seen[a.ID] {
			return errors.New("invalid balance account")
		}
		seen[a.ID] = true
	}
	raw, err := yaml.Marshal(struct {
		Version  int
		Accounts []balanceAccount
	}{1, accounts})
	if err != nil {
		return err
	}
	if len(raw) > 256<<10 {
		return errors.New("balance accounts exceed size limit")
	}
	return writeFileAtomic(filepath.Join(dir, balanceAccountsFile), raw, 0o600)
}

// Balance credentials are independent of pi authentication and are sent
// only to the explicitly configured endpoint, never through a redirect.
func queryBalanceAccount(ctx context.Context, a balanceAccount) (string, error) {
	if !a.valid() {
		return "", errors.New("invalid balance endpoint")
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(a.Key)
	if key != "" {
		key = providerKey(providerConfig{APIKey: key})
		if key == "" {
			return "", errors.New("balance credential environment variable is empty")
		}
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := *appHTTPClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return "", err
	}
	if len(raw) > 1<<20 {
		return "", errors.New("balance response too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var root any
	if err := decoder.Decode(&root); err != nil {
		return "", err
	}
	value, ok := jsonPath(root, firstNonEmpty(a.Path, "balance"))
	if !ok {
		return "", errors.New("balance JSON path not found")
	}
	amount, ok := floatField(value)
	if !ok || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return "", errors.New("balance is not a finite number")
	}
	return fmt.Sprintf("%s%.2f", currencySymbol(a.Currency), amount), nil
}
