package main

import (
	"net"
	"strings"

	"github.com/pion/turn/v4"
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

// peerAllowed reports whether media may be relayed to ip. The relay's own
// IP is allowed so two of its clients can reach each other (a call between
// two people behind the same proxy); selfConn keeps that to relay ports.
func (c *Config) peerAllowed(ip net.IP) bool {
	if ip.Equal(c.RelayIP) {
		return true
	}
	if !c.AllowPrivatePeers && containsIP(blockedPeers, ip) {
		return false
	}
	if containsIP(c.DenyPeers, ip) {
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

// relayPort reports whether port is one of the relay's own UDP ports.
func (c *Config) relayPort(port int) bool {
	return port >= int(c.RelayMinPort) && port <= int(c.RelayMaxPort)
}

// selfGenerator hands out relay sockets that only send to the relay's own IP
// on relay ports, so peerAllowed letting that IP through can't reach other
// services on the host.
type selfGenerator struct {
	turn.RelayAddressGenerator
	cfg *Config
}

func (g selfGenerator) AllocatePacketConn(network string, port int) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.RelayAddressGenerator.AllocatePacketConn(network, port)
	if err != nil {
		return nil, nil, err
	}
	return selfConn{conn, g.cfg}, addr, nil
}

type selfConn struct {
	net.PacketConn
	cfg *Config
}

func (c selfConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if u, ok := addr.(*net.UDPAddr); ok && !c.cfg.AllowPrivatePeers && u.IP.Equal(c.cfg.RelayIP) && !c.cfg.relayPort(u.Port) {
		return len(p), nil // dropped, like any other filtered datagram
	}
	return c.PacketConn.WriteTo(p, addr)
}
