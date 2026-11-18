//go:build !js && !android && !ios

package workbench

// Shutdown closes all agent processes and terminals owned by the workbench.
func Shutdown() { closeAllPi(); closeAllACP(); closeAllTerminals() }
