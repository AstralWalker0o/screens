package ops

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// Mem is host memory in bytes.
type Mem struct {
	Total     uint64 `json:"total"`
	Available uint64 `json:"available"`
}

// Disk is filesystem capacity in bytes.
type Disk struct {
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
}

// ReadLoad returns the 1/5/15 minute load averages.
func ReadLoad() [3]float64 {
	var out [3]float64
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out
	}
	f := strings.Fields(string(b))
	for i := 0; i < 3 && i < len(f); i++ {
		out[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return out
}

// ParseMeminfo parses /proc/meminfo content.
func ParseMeminfo(b []byte) Mem {
	var m Mem
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		v, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 2 && f[2] == "kB" {
			v *= 1024
		}
		switch f[0] {
		case "MemTotal:":
			m.Total = v
		case "MemAvailable:":
			m.Available = v
		}
	}
	return m
}

// ReadMem reads host memory.
func ReadMem() Mem {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return Mem{}
	}
	return ParseMeminfo(b)
}

// ReadDisk returns capacity of the filesystem holding path.
func ReadDisk(path string) Disk {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return Disk{}
	}
	bs := uint64(st.Bsize)
	return Disk{Total: st.Blocks * bs, Free: st.Bavail * bs}
}

// HostUptime returns the host uptime in seconds.
func HostUptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}
