//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"

	"example.com/pideck/internal/apptext"
)

type usageProbeCandidate struct {
	path, absoluteURL, template   string
	method                        string
	body                          any
	headers                       map[string]string
	hosts, apiTypes               []string
	rootPath, noVersion, noBearer bool
	preflight                     bool
	parse                         usageProbeParse
}

type usageProbeParse struct {
	kind, resolver, valuePath, currencyPath string
	totalPath, usedPath, remainingPath      string
	scale                                   float64
	windows                                 []usageProbeWindowSpec
	booster                                 *usageProbeBoosterSpec
}

type usageProbeWindowSpec struct {
	key, totalPath, usedPath, remainingPath, percentPath, listPath string
	where                                                          []usageProbeCondition
}

type usageProbeCondition struct {
	path string
	eq   any
}

type usageProbeBoosterSpec struct {
	balancePath, totalPath, currencyPath                  string
	monthlyUsedPath, monthlyLimitPath, monthlyEnabledPath string
	fixedPointPerCent                                     float64
}

func loadUsageProbeLegacy() ([]usageProbeCandidate, error) {
	usageProbeConfigMu.Lock()
	defer usageProbeConfigMu.Unlock()
	doc, err := readUsageProbeDocument()
	if err != nil {
		return nil, err
	}
	list, _ := doc["probes"].([]any)
	var candidates []usageProbeCandidate
	for _, value := range list {
		candidate, err := decodeUsageProbeLegacy(value)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, nil
}

func decodeUsageProbeLegacy(value any) (usageProbeCandidate, error) {
	bad := errors.New(apptext.T("旧用量探针格式无效；拒绝执行或覆盖配置"))
	entry, ok := value.(map[string]any)
	if !ok {
		return usageProbeCandidate{}, bad
	}
	match := usageProbeObject(entry["match"])
	request := usageProbeObject(entry["request"])
	candidate := usageProbeCandidate{
		path: usageProbeString(request["path"]), method: http.MethodGet,
		parse: usageProbeParse{kind: "periods"},
	}
	var valid bool
	candidate.hosts, valid = usageProbeStringList(match["baseUrlContains"])
	if !valid || len(candidate.hosts) == 0 || !usageProbeValidPath(candidate.path) {
		return candidate, bad
	}
	for i := range candidate.hosts {
		candidate.hosts[i] = strings.ToLower(candidate.hosts[i])
	}
	if raw, exists := match["apiTypes"]; exists {
		candidate.apiTypes, valid = usageProbeStringList(raw)
		if !valid {
			return candidate, bad
		}
	}
	if raw, exists := request["method"]; exists {
		candidate.method = usageProbeString(raw)
		if candidate.method != http.MethodGet && candidate.method != http.MethodPost {
			return candidate, bad
		}
	}
	for key, dest := range map[string]*bool{"rootPath": &candidate.rootPath, "skipBearer": &candidate.noBearer} {
		if raw, exists := request[key]; exists {
			value, ok := raw.(bool)
			if !ok {
				return candidate, bad
			}
			*dest = value
		}
	}
	candidate.body = request["body"]
	if raw, exists := request["headers"]; exists {
		headers, ok := raw.(map[string]any)
		if !ok {
			return candidate, bad
		}
		candidate.headers = make(map[string]string)
		for key, raw := range headers {
			text, ok := raw.(string)
			if !ok || strings.TrimSpace(key) == "" || strings.ContainsAny(key+text, "\r\n") {
				return candidate, bad
			}
			candidate.headers[key] = text
		}
	}
	if raw, exists := entry["parse"]; exists {
		parse, ok := raw.(map[string]any)
		if !ok {
			return candidate, bad
		}
		candidate.parse, valid = decodeUsageProbeParse(parse)
		if !valid {
			return candidate, bad
		}
	}
	return candidate, nil
}

func decodeUsageProbeParse(entry map[string]any) (usageProbeParse, bool) {
	parse := usageProbeParse{
		kind: usageProbeString(entry["kind"]), valuePath: usageProbeString(entry["valuePath"]),
		currencyPath: usageProbeString(entry["currencyPath"]), totalPath: usageProbeString(entry["totalPath"]),
		usedPath: usageProbeString(entry["usedPath"]), remainingPath: usageProbeString(entry["remainingPath"]),
	}
	if parse.kind == "" {
		parse.kind = "periods"
	}
	if parse.kind == "periods" {
		return parse, true
	}
	if parse.kind == "balance" {
		return parse, parse.valuePath != ""
	}
	if parse.kind != "credits" {
		return parse, false // Configuration never dispatches custom code or resolvers.
	}
	if raw, exists := entry["scale"]; exists {
		value := usageProbeNumber(raw)
		if value == nil || *value <= 0 {
			return parse, false
		}
		parse.scale = *value
	}
	if raw, exists := entry["windows"]; exists {
		list, ok := raw.([]any)
		if !ok {
			return parse, false
		}
		for _, raw := range list {
			window := usageProbeObject(raw)
			w := usageProbeWindowSpec{
				key: usageProbeString(window["key"]), totalPath: usageProbeString(window["totalPath"]),
				usedPath: usageProbeString(window["usedPath"]), remainingPath: usageProbeString(window["remainingPath"]),
				percentPath: usageProbeString(window["percentPath"]), listPath: usageProbeString(window["listPath"]),
			}
			if w.key == "" || w.totalPath == "" || w.usedPath == "" {
				return parse, false
			}
			if w.listPath != "" {
				conditions, ok := window["where"].([]any)
				if !ok || len(conditions) == 0 {
					return parse, false
				}
				for _, raw := range conditions {
					condition := usageProbeObject(raw)
					eq, exists := condition["eq"]
					switch eq.(type) {
					case nil, string, bool, json.Number:
					default:
						return parse, false
					}
					path := usageProbeString(condition["path"])
					if path == "" || !exists {
						return parse, false
					}
					w.where = append(w.where, usageProbeCondition{path, eq})
				}
			}
			parse.windows = append(parse.windows, w)
		}
	}
	if raw, exists := entry["booster"]; exists {
		box := usageProbeObject(raw)
		b := &usageProbeBoosterSpec{
			balancePath: usageProbeString(box["balancePath"]), totalPath: usageProbeString(box["totalPath"]),
			currencyPath: usageProbeString(box["currencyPath"]), monthlyUsedPath: usageProbeString(box["monthlyUsedCentsPath"]),
			monthlyLimitPath: usageProbeString(box["monthlyChargeLimitCentsPath"]), monthlyEnabledPath: usageProbeString(box["monthlyChargeLimitEnabledPath"]),
			fixedPointPerCent: 1_000_000,
		}
		if b.balancePath == "" {
			return parse, false
		}
		if raw, exists := box["fixedPointPerCent"]; exists {
			n := usageProbeNumber(raw)
			if n == nil || *n <= 0 {
				return parse, false
			}
			b.fixedPointPerCent = *n
		}
		parse.booster = b
	}
	return parse, parse.totalPath != "" || parse.usedPath != "" || parse.remainingPath != "" || len(parse.windows) > 0 || parse.booster != nil
}

func usageProbeStringList(value any) ([]string, bool) {
	list, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, raw := range list {
		text, ok := raw.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, false
		}
		out = append(out, strings.TrimSpace(text))
	}
	return out, true
}

func usageProbeEquals(value, expected any) bool {
	if list, ok := expected.([]any); ok {
		for _, item := range list {
			if usageProbeEquals(value, item) {
				return true
			}
		}
		return false
	}
	// Numbers decoded from JSON have a textual representation; 3 and 3.0
	// are still the same JSON number, but a numeric string is a distinct value.
	if a, ok := value.(json.Number); ok {
		if b, ok := expected.(json.Number); ok {
			av, ae := a.Float64()
			bv, be := b.Float64()
			return ae == nil && be == nil && av == bv
		}
	}
	return reflect.DeepEqual(value, expected)
}
