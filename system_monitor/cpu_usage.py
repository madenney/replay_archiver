"""
CPU usage sampler using /proc/stat. The first call returns None because we need
two snapshots to calculate utilization.
"""

_prev_total = None
_prev_idle = None


def _read_cpu_times():
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            first = f.readline()
    except OSError:
        return None

    parts = first.split()
    if not parts or parts[0] != "cpu":
        return None

    try:
        values = list(map(int, parts[1:]))
    except ValueError:
        return None

    # Idle = idle + iowait, total = sum of all modes.
    idle = values[3] + values[4]
    total = sum(values)
    return idle, total


def get_cpu_usage():
    """
    Returns CPU utilization as a percentage (float) or None if not available yet.
    """
    global _prev_total, _prev_idle
    snapshot = _read_cpu_times()
    if snapshot is None:
        return None

    idle, total = snapshot
    if _prev_total is None:
        _prev_total, _prev_idle = total, idle
        return None

    delta_total = total - _prev_total
    delta_idle = idle - _prev_idle
    _prev_total, _prev_idle = total, idle

    if delta_total <= 0:
        return None

    usage = 100.0 * (1.0 - (delta_idle / delta_total))
    return round(usage, 1)
