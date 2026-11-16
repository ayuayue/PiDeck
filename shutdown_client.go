//go:build js || android || ios

package main

// A page starts no processes, so it has none to close.

func shutdownHosts() {}
