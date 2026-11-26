package netcfg

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"syscall"
	"time"
)

// Lease is an IPv4 address obtained by DHCP. Only the address and prefix are applied; routers and DNS servers
// offered by the network are deliberately ignored so a VLAN leg can never change the host's routing or resolver.
type Lease struct {
	Prefix   netip.Prefix
	Server   netip.Addr
	Duration time.Duration
}

const (
	dhcpDiscover = 1
	dhcpOffer    = 2
	dhcpRequest  = 3
	dhcpAck      = 5
	dhcpNak      = 6
)

var magicCookie = []byte{99, 130, 83, 99}

// buildDHCP builds a BOOTREQUEST with the broadcast flag set (we have no address yet).
func buildDHCP(msgType byte, xid uint32, mac net.HardwareAddr, requested, server netip.Addr) []byte {
	b := make([]byte, 240, 300)
	b[0], b[1], b[2] = 1, 1, 6 // BOOTREQUEST, Ethernet, hlen 6
	binary.BigEndian.PutUint32(b[4:8], xid)
	binary.BigEndian.PutUint16(b[10:12], 0x8000) // broadcast flag
	copy(b[28:34], mac)
	copy(b[236:240], magicCookie)
	b = append(b, 53, 1, msgType)
	b = append(b, 61, 7, 1)
	b = append(b, mac[:6]...)
	b = append(b, 55, 3, 1, 51, 54) // subnet mask, lease time, server id
	if requested.IsValid() {
		a := requested.As4()
		b = append(b, 50, 4, a[0], a[1], a[2], a[3])
	}
	if server.IsValid() {
		a := server.As4()
		b = append(b, 54, 4, a[0], a[1], a[2], a[3])
	}
	b = append(b, 12, 7, 's', 'c', 'r', 'e', 'e', 'n', 's')
	return append(b, 255)
}

type dhcpReply struct {
	msgType byte
	yiaddr  netip.Addr
	mask    net.IPMask
	server  netip.Addr
	lease   time.Duration
}

func parseDHCP(b []byte, xid uint32) (dhcpReply, bool) {
	var r dhcpReply
	if len(b) < 240 || b[0] != 2 || binary.BigEndian.Uint32(b[4:8]) != xid || string(b[236:240]) != string(magicCookie) {
		return r, false
	}
	r.yiaddr = netip.AddrFrom4([4]byte(b[16:20]))
	for i := 240; i < len(b); {
		code := b[i]
		if code == 255 {
			break
		}
		if code == 0 {
			i++
			continue
		}
		if i+1 >= len(b) {
			break
		}
		n := int(b[i+1])
		if i+2+n > len(b) {
			break
		}
		v := b[i+2 : i+2+n]
		switch code {
		case 53:
			if n == 1 {
				r.msgType = v[0]
			}
		case 1:
			if n == 4 {
				r.mask = net.IPMask(append([]byte(nil), v...))
			}
		case 54:
			if n == 4 {
				r.server = netip.AddrFrom4([4]byte(v))
			}
		case 51:
			if n == 4 {
				r.lease = time.Duration(binary.BigEndian.Uint32(v)) * time.Second
			}
		}
		i += 2 + n
	}
	return r, r.msgType != 0
}

// dhcpSocket opens a UDP socket on :68 bound to one interface, able to send and receive broadcasts.
func dhcpSocket(ctx context.Context, ifname string) (net.PacketConn, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			for _, o := range []int{syscall.SO_REUSEADDR, 15 /* SO_REUSEPORT */, syscall.SO_BROADCAST} {
				if e := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, o, 1); e != nil && o != 15 {
					serr = e
				}
			}
			if e := syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, ifname); e != nil {
				serr = fmt.Errorf("bind to %s: %w", ifname, e)
			}
		})
		if err != nil {
			return err
		}
		return serr
	}}
	return lc.ListenPacket(ctx, "udp4", "0.0.0.0:68")
}

// AcquireLease performs DISCOVER/OFFER/REQUEST/ACK on ifname. `prefer` (optional) asks for the previous address.
func AcquireLease(ctx context.Context, ifname string, prefer netip.Addr) (Lease, error) {
	ifc, err := net.InterfaceByName(ifname)
	if err != nil {
		return Lease{}, err
	}
	if len(ifc.HardwareAddr) < 6 {
		return Lease{}, fmt.Errorf("%s has no Ethernet address", ifname)
	}
	pc, err := dhcpSocket(ctx, ifname)
	if err != nil {
		return Lease{}, err
	}
	defer pc.Close()
	var xb [4]byte
	_, _ = rand.Read(xb[:])
	xid := binary.BigEndian.Uint32(xb[:])
	bcast := &net.UDPAddr{IP: net.IPv4bcast, Port: 67}

	exchange := func(msg []byte, want ...byte) (dhcpReply, error) {
		buf := make([]byte, 1500)
		for attempt := 0; attempt < 4; attempt++ {
			if _, err := pc.WriteTo(msg, bcast); err != nil {
				return dhcpReply{}, err
			}
			deadline := time.Now().Add(time.Duration(2+attempt*2) * time.Second)
			for {
				if ctx.Err() != nil {
					return dhcpReply{}, ctx.Err()
				}
				_ = pc.SetReadDeadline(deadline)
				n, _, err := pc.ReadFrom(buf)
				if err != nil {
					var ne net.Error
					if errors.As(err, &ne) && ne.Timeout() {
						break
					}
					return dhcpReply{}, err
				}
				r, ok := parseDHCP(buf[:n], xid)
				if !ok {
					continue
				}
				if r.msgType == dhcpNak {
					return r, errors.New("DHCP server refused the request (NAK)")
				}
				for _, w := range want {
					if r.msgType == w {
						return r, nil
					}
				}
			}
		}
		return dhcpReply{}, errors.New("no answer from a DHCP server on this network")
	}

	offer, err := exchange(buildDHCP(dhcpDiscover, xid, ifc.HardwareAddr, prefer, netip.Addr{}), dhcpOffer)
	if err != nil {
		return Lease{}, err
	}
	ack, err := exchange(buildDHCP(dhcpRequest, xid, ifc.HardwareAddr, offer.yiaddr, offer.server), dhcpAck)
	if err != nil {
		return Lease{}, err
	}
	mask := ack.mask
	if mask == nil {
		mask = offer.mask
	}
	if mask == nil {
		mask = net.CIDRMask(24, 32)
	}
	ones, _ := mask.Size()
	d := ack.lease
	if d <= 0 {
		d = time.Hour
	}
	srv := ack.server
	if !srv.IsValid() {
		srv = offer.server
	}
	return Lease{Prefix: netip.PrefixFrom(ack.yiaddr, ones), Server: srv, Duration: d}, nil
}
