package main

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

// Config holds every setting for the relay. Each field can be set by flag
// (-relay-ip) or by environment variable (DLPCC_RELAY_IP); flags win. The
// Node wrapper passes everything as environment so the secret stays out of
// the process list.
type Config struct {
	// Secret checks the TURN REST credentials the Node wrapper signs.
	Secret string
	Realm  string

	// TURNListen is the plain TCP TURN listener. nginx terminates TLS on 443
	// and forwards the decrypted stream here, so keep it on loopback.
	TURNListen string

	// RelayIP is the public address advertised in relay candidates; RelayBind
	// is where the relay UDP sockets are opened.
	RelayIP      net.IP
	RelayBind    string
	RelayMinPort uint16
	RelayMaxPort uint16

	AllowPeers []*net.IPNet
	DenyPeers  []*net.IPNet
	// AllowPrivatePeers lifts the built-in private range and relay IP block,
	// for testing on one machine or a LAN.
	AllowPrivatePeers bool
	MaxAllocsPerUser  int
	MaxAllocs         int

	// UpstreamProxy sends relayed media out through a SOCKS5 proxy with UDP
	// support instead of straight from this server.
	UpstreamProxy *socksProxy

	LogLevel string
}

func envName(flagName string) string {
	return "DLPCC_" + strings.ToUpper(strings.ReplaceAll(flagName, "-", "_"))
}

func envOr(flagName, def string) string {
	if v, ok := os.LookupEnv(envName(flagName)); ok {
		return v
	}
	return def
}

// Load parses flags (and DLPCC_* environment fallbacks) into a Config.
func Load(args []string) (*Config, error) {
	fs := flag.NewFlagSet("dlpcc-relay", flag.ContinueOnError)
	str := func(name, def, usage string) *string {
		return fs.String(name, envOr(name, def), usage+" (env "+envName(name)+")")
	}

	secret := str("secret", "", "shared secret the Node wrapper signs TURN credentials with (required)")
	realm := str("realm", "dlpcc", "TURN realm")
	turnListen := str("turn-listen", "127.0.0.1:3478", "plain TCP TURN listener that nginx forwards decrypted TLS to")
	relayIP := str("relay-ip", "", "public IPv4 address advertised for relayed media (required)")
	relayBind := str("relay-bind", "0.0.0.0", "local address relay sockets bind to")
	relayPorts := str("relay-ports", "49152-65535", "UDP port range for relay sockets")
	allowPeers := str("allow-peers", "", "comma separated CIDRs; when set, only these peers can be relayed to")
	denyPeers := str("deny-peers", "", "extra comma separated CIDRs to block on top of the built-in private ranges")
	allowPrivate := str("allow-private-peers", "false", "relay to private, loopback and the relay's own addresses too; testing only")
	perUser := str("max-allocs-per-user", "8", "concurrent allocations per credential, 0 = unlimited")
	maxAllocs := str("max-allocs", "1000", "concurrent allocations in total, 0 = unlimited")
	upstreamProxy := str("upstream-proxy", "", "socks5://[user:pass@]host:port with UDP support to send relayed media out through")
	logLevel := str("log-level", "warn", "pion log level: error, warn, info, debug, trace")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	cfg := &Config{
		Secret:     *secret,
		Realm:      *realm,
		TURNListen: *turnListen,
		RelayBind:  *relayBind,
		LogLevel:   *logLevel,
	}

	if cfg.Secret == "" {
		return nil, errors.New("secret is required")
	}
	if cfg.RelayIP = net.ParseIP(*relayIP).To4(); cfg.RelayIP == nil {
		return nil, fmt.Errorf("relay-ip %q is not an IPv4 address", *relayIP)
	}

	var err error
	if cfg.RelayMinPort, cfg.RelayMaxPort, err = parsePortRange(*relayPorts); err != nil {
		return nil, err
	}
	if cfg.AllowPeers, err = parseCIDRs(*allowPeers); err != nil {
		return nil, fmt.Errorf("allow-peers: %w", err)
	}
	if cfg.DenyPeers, err = parseCIDRs(*denyPeers); err != nil {
		return nil, fmt.Errorf("deny-peers: %w", err)
	}
	if cfg.AllowPrivatePeers, err = strconv.ParseBool(*allowPrivate); err != nil {
		return nil, fmt.Errorf("allow-private-peers: %w", err)
	}
	if cfg.MaxAllocsPerUser, err = strconv.Atoi(*perUser); err != nil {
		return nil, fmt.Errorf("max-allocs-per-user: %w", err)
	}
	if cfg.MaxAllocs, err = strconv.Atoi(*maxAllocs); err != nil {
		return nil, fmt.Errorf("max-allocs: %w", err)
	}
	if cfg.UpstreamProxy, err = parseSocksProxy(*upstreamProxy); err != nil {
		return nil, fmt.Errorf("upstream-proxy: %w", err)
	}

	return cfg, nil
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func parseCIDRs(s string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, part := range splitList(s) {
		if !strings.Contains(part, "/") {
			if strings.Contains(part, ":") {
				part += "/128"
			} else {
				part += "/32"
			}
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

func parsePortRange(s string) (uint16, uint16, error) {
	lo, hi, ok := strings.Cut(s, "-")
	if !ok {
		return 0, 0, fmt.Errorf("relay-ports %q must look like 49152-65535", s)
	}
	min, err1 := strconv.ParseUint(strings.TrimSpace(lo), 10, 16)
	max, err2 := strconv.ParseUint(strings.TrimSpace(hi), 10, 16)
	if err1 != nil || err2 != nil || min == 0 || min > max {
		return 0, 0, fmt.Errorf("relay-ports %q is not a valid range", s)
	}
	return uint16(min), uint16(max), nil
}
