// Command dlpcc-relay is the TURN relay behind nginx on 443, so WebRTC media
// from proxied pages travels as TLS instead of blocked UDP. The dlpcc npm
// package spawns it and mints the credentials it checks.
package main

import (
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	cfg, err := Load(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatalf("dlpcc-relay: %v", err)
	}

	srv, err := Start(cfg)
	if err != nil {
		log.Fatalf("dlpcc-relay: %v", err)
	}
	log.Printf("dlpcc-relay: turn on %s, relaying as %s ports %d-%d", cfg.TURNListen, cfg.RelayIP, cfg.RelayMinPort, cfg.RelayMaxPort)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig

	if err := srv.Close(); err != nil {
		log.Printf("dlpcc-relay: shutdown: %v", err)
	}
}
