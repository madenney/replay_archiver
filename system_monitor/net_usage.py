"""
Network throughput sampler using /proc/net/dev. The first call returns None
because two samples are required to compute bandwidth.
"""

import time

_prev_sample = None  # (timestamp, total_bytes)


def _read_total_bytes():
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return None

    total_bytes = 0
    for line in lines[2:]:  # Skip headers
        if ":" not in line:
            continue
        iface, data = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo":
            continue
        fields = data.split()
        if len(fields) < 8:
            continue
        try:
            rx_bytes = int(fields[0])
            tx_bytes = int(fields[8])
        except (ValueError, IndexError):
            continue
        total_bytes += rx_bytes + tx_bytes
    return total_bytes


def get_network_mbps():
    """
    Returns aggregate bandwidth in Mbps (float) across interfaces except loopback,
    or None if not enough data yet.
    """
    global _prev_sample
    now = time.time()
    total_bytes = _read_total_bytes()
    if total_bytes is None:
        return None

    if _prev_sample is None:
        _prev_sample = (now, total_bytes)
        return None

    prev_time, prev_bytes = _prev_sample
    elapsed = now - prev_time
    if elapsed <= 0:
        return None

    bytes_diff = total_bytes - prev_bytes
    _prev_sample = (now, total_bytes)

    # Convert bytes/sec to megabits/sec.
    mbps = (bytes_diff * 8) / (1_000_000 * elapsed)
    return round(mbps, 2)
