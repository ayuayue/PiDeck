//go:build !js && !android && !ios

package workbench

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type piUpdateState struct {
	Path, Installed, Latest string
	Error                   string
	Checking, Updating      bool
}

func (s piUpdateState) busy() bool { return s.Checking || s.Updating }

func (s piUpdateState) matches(info envInfo) bool {
	return s.Path == info.PiPath && s.Installed == info.PiVersion
}

func (s piUpdateState) available(info envInfo) bool {
	return s.matches(info) && piReleaseNewer(info.PiVersion, s.Latest)
}

// pi owns installation detection and self-update, including custom commands
// and Windows native-module handling. Never replace this with a global npm
// install, which could update a different executable than the selected one.
func runPiSelfUpdate(ctx context.Context, path string) error {
	cmd := piCommand(ctx, path, "update", "--self", "--no-approve")
	cmd.Dir = loginDir()
	cmd.Env = append(cmd.Environ(), agentProxy.env()...)
	cmd.WaitDelay = 2 * time.Second
	log := &ringBuffer{limit: 16 << 10}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		if detail := strings.TrimSpace(log.String()); detail != "" {
			return fmt.Errorf("%w\n%s", err, detail)
		}
		return err
	}
	return nil
}

func (a *app) updatePiRuntime() {
	state, info := a.piUpdate.GetUntracked(), a.env.GetUntracked()
	if state.busy() || !state.available(info) || info.Probing || info.PiError != "" {
		return
	}
	executable := a.cfg.PiExecutable
	state.Updating, state.Error = true, ""
	a.piUpdate.Set(state)
	go func() {
		ctx, cancel := a.piPackageContext()
		defer cancel()
		err := runPiSelfUpdate(ctx, state.Path)
		path, version, probeErr := "", "", error(nil)
		if err == nil {
			path, version, probeErr = probePiWithExecutable("", "", state.Path)
		}
		a.cx.Post(func() {
			state.Updating = false
			if err != nil {
				state.Error = err.Error()
			} else if probeErr != nil {
				state.Error = probeErr.Error()
			}
			current := a.env.GetUntracked()
			if err == nil && executable == a.cfg.PiExecutable && current.PiPath == state.Path {
				current.PiPath, current.PiVersion, current.PiError = path, version, ""
				if probeErr != nil {
					current.PiError = probeErr.Error()
				}
				current.Probed, current.Probing = true, false
				a.env.Set(current)
				state.Path, state.Installed = path, version
			}
			a.piUpdate.Set(state)
		})
	}()
}

// npm's latest tag is a semantic version. Compare numeric components before
// prerelease identifiers, so a newer local build never offers a downgrade.
func piReleaseNewer(installed, latest string) bool {
	parse := func(value string) ([3]uint64, string, bool) {
		value, _, _ = strings.Cut(strings.TrimPrefix(strings.TrimSpace(value), "v"), "+")
		base, prerelease, _ := strings.Cut(value, "-")
		parts := strings.Split(base, ".")
		var numbers [3]uint64
		if len(parts) != len(numbers) {
			return numbers, "", false
		}
		for i, part := range parts {
			number, err := strconv.ParseUint(part, 10, 64)
			if err != nil {
				return numbers, "", false
			}
			numbers[i] = number
		}
		return numbers, prerelease, true
	}
	a, aPre, aOK := parse(installed)
	b, bPre, bOK := parse(latest)
	if !aOK || !bOK {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return b[i] > a[i]
		}
	}
	if aPre == bPre || aPre == "" {
		return false
	}
	if bPre == "" {
		return true
	}
	aParts, bParts := strings.Split(aPre, "."), strings.Split(bPre, ".")
	for i := 0; i < len(aParts) && i < len(bParts); i++ {
		if aParts[i] == bParts[i] {
			continue
		}
		aNumber, aErr := strconv.ParseUint(aParts[i], 10, 64)
		bNumber, bErr := strconv.ParseUint(bParts[i], 10, 64)
		if aErr == nil && bErr == nil {
			return bNumber > aNumber
		}
		if aErr == nil || bErr == nil {
			return bErr != nil
		}
		return bParts[i] > aParts[i]
	}
	return len(bParts) > len(aParts)
}
