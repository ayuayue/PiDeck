//go:build !js && !android && !ios

package main

// The processes and terminals the workbench started end with it.

func shutdownHosts() {
	closeAllPi()
	closeAllACP()
	closeAllTerminals()
}
