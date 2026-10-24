package main

import (
	"net"
	"strings"
)

// blockedPeers are never valid relay targets. Without this anyone holding a
// credential could use the relay to reach the server's own network.
var blockedPeers = mustCIDRs(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/128",
	"::1/128",
	"64:ff9b::/96",
	"2001:db8::/32",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
)

func mustCIDRs(cidrs ...string) []*net.IPNet {
	nets, err := parseCIDRs(strings.Join(cidrs, ","))
	if err != nil {
		panic(err)
	}
	return nets
}

// peerAllowed reports whether media may be relayed to ip.
func (c *Config) peerAllowed(ip net.IP) bool {
	if ip.Equal(c.RelayIP) || containsIP(blockedPeers, ip) || containsIP(c.DenyPeers, ip) {
		return false
	}
	return len(c.AllowPeers) == 0 || containsIP(c.AllowPeers, ip)
}

func containsIP(nets []*net.IPNet, ip net.IP) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
