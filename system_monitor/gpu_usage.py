"""
GPU usage sampler via nvidia-smi. Returns the first GPU's utilization percent.
If nvidia-smi is unavailable, returns None.
"""

import subprocess


def get_gpu_usage():
    """
    Returns GPU utilization as a percentage (float) or None on failure.
    """
    try:
        output = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return None

    try:
        value = float(lines[0])
    except ValueError:
        return None

    return round(value, 1)
