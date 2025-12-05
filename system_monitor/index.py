"""
Simple live system monitor with three stacked charts (GPU %, CPU %, Network Mbps).
Default view is 60s wide; quick toggles jump to longer history windows.
GPU/CPU Y-axis fixed 0-100; network auto scales to the last seen maximum.
Updates once per second. Starts with a blank 60s buffer (not written to CSV)
and uses only the standard library plus nvidia-smi for GPU.
"""

import atexit
import csv
import re
from datetime import datetime, timezone
from pathlib import Path

import tkinter as tk
from tkinter import ttk

from cpu_usage import get_cpu_usage
from gpu_usage import get_gpu_usage
from net_usage import get_network_mbps

SAMPLE_MS = 1000
DEFAULT_HISTORY_SECONDS = 60
LOG_WARMUP_SECONDS = 60  # skip logging for the first minute
DURATION_OPTIONS = [
    ("60s", 60),
    ("5m", 5 * 60),
    ("10m", 10 * 60),
    ("1h", 60 * 60),
    ("3h", 3 * 60 * 60),
    ("8h", 8 * 60 * 60),
    ("16h", 16 * 60 * 60),
    ("24h", 24 * 60 * 60),
]
OUTPUT_DIR = Path(__file__).parent / "output"


def _seconds_to_points(seconds):
    return max(2, int((seconds * 1000) / SAMPLE_MS))


def _next_log_path():
    OUTPUT_DIR.mkdir(exist_ok=True)
    pattern = re.compile(r"monitor_data_(\d+)\.csv$")
    max_n = 0
    for path in OUTPUT_DIR.iterdir():
        match = pattern.match(path.name)
        if match:
            max_n = max(max_n, int(match.group(1)))
    return OUTPUT_DIR / f"monitor_data_{max_n + 1}.csv"


class ChartPanel:
    def __init__(self, parent, title, color, unit, max_points, sample_ms, fixed_max=None):
        self.color = color
        self.unit = unit
        self.max_points = max_points
        self.sample_ms = sample_ms
        self.fixed_max = fixed_max
        self.data = [None] * self.max_points
        self.last_display_value = None
        self.last_dynamic_max = None

        self.frame = tk.Frame(parent, bg="#0f1115")
        self.frame.pack(fill="both", expand=True, padx=10, pady=6)

        self.title_label = tk.Label(
            self.frame,
            text=title,
            anchor="w",
            fg="#e2e2e2",
            bg="#0f1115",
            font=("Helvetica", 12, "bold"),
        )
        self.title_label.pack(fill="x")

        self.canvas = tk.Canvas(
            self.frame,
            height=160,
            bg="#151821",
            highlightthickness=0,
        )
        self.canvas.pack(fill="both", expand=True)

    def add_point(self, value):
        if len(self.data) >= self.max_points:
            self.data = self.data[1:]
        self.data.append(value)
        self.last_display_value = value
        self._render(value)

    def set_max_points(self, max_points):
        self.max_points = max_points
        self.data = self.data[-self.max_points :]
        if len(self.data) < self.max_points:
            pad = [None] * (self.max_points - len(self.data))
            self.data = pad + self.data
        # Re-render using last known sample value.
        self._render(self.last_display_value)

    def _render(self, current_value):
        c = self.canvas
        c.delete("all")

        width = c.winfo_width() or c.winfo_reqwidth()
        height = c.winfo_height() or c.winfo_reqheight()
        pad = 12
        usable_w = max(10, width - 2 * pad)
        usable_h = max(10, height - 2 * pad)

        # Draw background grid.
        for i in range(1, 4):
            y = pad + (usable_h * i) / 4
            c.create_line(
                pad,
                y,
                width - pad,
                y,
                fill="#20232d",
                dash=(2, 3),
            )

        # Axis outline.
        c.create_rectangle(
            pad,
            pad,
            width - pad,
            height - pad,
            outline="#2c3240",
        )

        # X-axis ticks (quarters, no labels).
        tick_y1 = height - pad
        tick_y2 = tick_y1 + 6
        for i in range(5):
            x = pad + (usable_w * i) / 4
            c.create_line(
                x,
                tick_y1,
                x,
                tick_y2,
                fill="#2c3240",
                width=1,
            )

        non_null = [v for v in self.data if v is not None]
        if self.fixed_max is not None:
            max_val = max(1, self.fixed_max)
        else:
            if non_null:
                current_max = max(non_null)
                if self.last_dynamic_max is None or current_max > self.last_dynamic_max:
                    self.last_dynamic_max = current_max
            if self.last_dynamic_max is None:
                self.last_dynamic_max = 1
            max_val = self.last_dynamic_max

        points = []
        if non_null:
            slots = max(1, self.max_points - 1)
            for idx, val in enumerate(self.data):
                if val is None:
                    continue
                val_to_plot = min(val, max_val)
                x = pad + (usable_w * idx) / slots
                y = height - pad - (usable_h * (val_to_plot / max_val))
                points.append((x, y))

        # Line plot (needs at least two points). Draw a dot otherwise.
        if len(points) >= 2:
            flat_points = [coord for point in points for coord in point]
            c.create_line(flat_points, fill=self.color, width=2)
        elif len(points) == 1:
            x, y = points[0]
            c.create_oval(
                x - 2,
                y - 2,
                x + 2,
                y + 2,
                fill=self.color,
                outline=self.color,
            )

        # Current value text.
        display_value = "…" if current_value is None else f"{current_value:.2f}"
        c.create_text(
            width - pad,
            pad + 2,
            anchor="ne",
            fill="#cdd2de",
            font=("Helvetica", 11, "bold"),
            text=f"{display_value} {self.unit}",
        )

        # Max scale indicator (network only).
        if self.fixed_max is None:
            c.create_text(
                pad + 2,
                pad + 2,
                anchor="nw",
                fill="#7d8499",
                font=("Helvetica", 9),
                text=f"max {max_val:.0f} {self.unit}",
            )


def main():
    root = tk.Tk()
    root.title("System Monitor")
    root.configure(bg="#0f1115")
    root.minsize(720, 520)

    style = ttk.Style()
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure(
        "Monitor.TRadiobutton",
        background="#0f1115",
        foreground="#cdd2de",
        font=("Helvetica", 10, "bold"),
    )

    history_var = tk.IntVar(value=DEFAULT_HISTORY_SECONDS)

    control_frame = tk.Frame(root, bg="#0f1115")
    control_frame.pack(fill="x", padx=10, pady=(10, 4))

    charts_container = tk.Frame(root, bg="#0f1115")
    charts_container.pack(fill="both", expand=True)

    charts = {
        "gpu": ChartPanel(
            charts_container,
            "GPU",
            "#6ea8fe",
            "%",
            _seconds_to_points(history_var.get()),
            SAMPLE_MS,
            fixed_max=100,
        ),
        "cpu": ChartPanel(
            charts_container,
            "CPU",
            "#9ef0c0",
            "%",
            _seconds_to_points(history_var.get()),
            SAMPLE_MS,
            fixed_max=100,
        ),
        "net": ChartPanel(
            charts_container,
            "Network",
            "#f2c94c",
            "Mbps",
            _seconds_to_points(history_var.get()),
            SAMPLE_MS,
            fixed_max=None,
        ),
    }

    def apply_history():
        points = _seconds_to_points(history_var.get())
        for chart in charts.values():
            chart.set_max_points(points)

    for label, seconds in DURATION_OPTIONS:
        btn = ttk.Radiobutton(
            control_frame,
            text=label,
            value=seconds,
            variable=history_var,
            command=apply_history,
            style="Monitor.TRadiobutton",
        )
        btn.pack(side="left", padx=3)

    log_path = _next_log_path()
    log_file = log_path.open("w", newline="", encoding="utf-8")
    csv_writer = csv.writer(log_file)
    csv_writer.writerow(["timestamp", "gpu_percent", "cpu_percent", "net_mbps"])
    atexit.register(log_file.close)

    # Ensure the log file is closed when the window closes.
    def on_close():
        try:
            log_file.flush()
        finally:
            root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    samples_taken = 0
    warmup_samples = _seconds_to_points(LOG_WARMUP_SECONDS)

    def tick():
        nonlocal samples_taken
        gpu_val = get_gpu_usage()
        cpu_val = get_cpu_usage()
        net_val = get_network_mbps()

        charts["gpu"].add_point(gpu_val)
        charts["cpu"].add_point(cpu_val)
        charts["net"].add_point(net_val)

        timestamp = datetime.now(timezone.utc).isoformat()
        if samples_taken >= warmup_samples:
            csv_writer.writerow(
                [
                    timestamp,
                    "" if gpu_val is None else gpu_val,
                    "" if cpu_val is None else cpu_val,
                    "" if net_val is None else net_val,
                ]
            )
            log_file.flush()

        samples_taken += 1
        root.after(SAMPLE_MS, tick)

    # Prime data to draw grid before first tick.
    for chart in charts.values():
        chart._render(None)

    root.after(SAMPLE_MS, tick)
    root.mainloop()


if __name__ == "__main__":
    main()
