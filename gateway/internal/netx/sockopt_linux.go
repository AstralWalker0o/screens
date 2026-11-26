//go:build linux

package netx

// SO_REUSEPORT on Linux (not exported by package syscall on every arch).
const soReusePort = 0xf

// IP_MULTICAST_ALL on Linux.
const ipMulticastAll = 49
