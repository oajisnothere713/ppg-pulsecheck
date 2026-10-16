#!/usr/bin/env python3
"""Create auditable PPG quality-control plots from the packetized JSON input.

This script never edits the source JSON and never fills packet gaps. It creates:
  - ppg_quality_overview.png: all raw streams with review/exclusion overlays
  - s4_filter_comparison.png: raw vs. zero-phase filtered S4
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch
from scipy.signal import butter, sosfiltfilt


LOW_CUTOFF_HZ = 0.4
HIGH_CUTOFF_HZ = 12.0
QUALITY_WINDOW_SECONDS = 5.0
MAX_HIGH_FREQUENCY_RATIO = 0.05
MAX_LOW_FREQUENCY_RATIO = 0.35
FLATLINE_MINIMUM_SAMPLES = 10
FLATLINE_TOLERANCE = 1e-10


@dataclass(frozen=True)
class Interval:
    start: int
    end: int
    reason: str


@dataclass
class Stream:
    identifier: str
    sample_indices: np.ndarray
    values: np.ndarray
    issues: list[str]
    excluded: list[Interval]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plot packet integrity, quality gates, and S4 filter comparison for PPG JSON data."
    )
    parser.add_argument("--input", required=True, type=Path, help="Path to the source PPG JSON file.")
    parser.add_argument(
        "--output-dir", type=Path, default=Path("python-output"), help="Directory for PNG figures."
    )
    parser.add_argument(
        "--no-show",
        action="store_false",
        dest="show",
        default=True,
        help="Save the PNG files without opening the Matplotlib windows (for batch or headless runs).",
    )
    return parser.parse_args()


def merge_intervals(intervals: list[Interval]) -> list[Interval]:
    """Merge only overlapping intervals that share a reason."""
    merged: list[Interval] = []
    for interval in sorted(intervals, key=lambda item: (item.start, item.end, item.reason)):
        if merged and interval.reason == merged[-1].reason and interval.start <= merged[-1].end:
            merged[-1] = Interval(merged[-1].start, max(merged[-1].end, interval.end), interval.reason)
        else:
            merged.append(interval)
    return merged


def flatline_intervals(indices: np.ndarray, values: np.ndarray) -> list[Interval]:
    intervals: list[Interval] = []
    run_start = 0
    for position in range(1, len(values) + 1):
        continues = (
            position < len(values)
            and indices[position] == indices[position - 1] + 1
            and abs(values[position] - values[position - 1]) <= FLATLINE_TOLERANCE
        )
        if continues:
            continue
        if position - run_start >= FLATLINE_MINIMUM_SAMPLES:
            intervals.append(Interval(int(indices[run_start]), int(indices[position - 1] + 1), "flatline"))
        run_start = position
    return intervals


def reconstruct_stream(recording: dict[str, Any], expected_samples: int) -> Stream:
    indices: list[int] = []
    values: list[float] = []
    issues: list[str] = []
    excluded: list[Interval] = []
    previous: dict[str, Any] | None = None

    for packet_position, packet in enumerate(recording["packets"]):
        packet_values = packet.get("values", [])
        if packet["sample_count"] != len(packet_values):
            issues.append(f"packet {packet_position}: declared and actual sample count differ")
        if previous is not None:
            expected_sequence = previous["sequence"] + 1
            expected_index = previous["first_sample_index"] + previous["sample_count"]
            if packet["sequence"] != expected_sequence:
                issues.append(f"packet {packet_position}: sequence discontinuity")
            if packet["first_sample_index"] != expected_index:
                issues.append(f"packet {packet_position}: sample-index discontinuity")
                if packet["first_sample_index"] > expected_index:
                    excluded.append(Interval(expected_index, packet["first_sample_index"], "missing packet samples"))
        indices.extend(packet["first_sample_index"] + offset for offset in range(len(packet_values)))
        values.extend(float(value) for value in packet_values)
        previous = packet

    index_array = np.asarray(indices, dtype=int)
    value_array = np.asarray(values, dtype=float)
    if len(value_array) != expected_samples:
        issues.append(f"recording has {len(value_array)} samples; expected {expected_samples}")
    excluded.extend(flatline_intervals(index_array, value_array))
    return Stream(recording["recording_id"], index_array, value_array, issues, merge_intervals(excluded))


def interval_mask(indices: np.ndarray, intervals: list[Interval]) -> np.ndarray:
    mask = np.zeros(len(indices), dtype=bool)
    for interval in intervals:
        mask |= (indices >= interval.start) & (indices < interval.end)
    return mask


def contiguous_segments(indices: np.ndarray, values: np.ndarray, excluded: list[Interval]) -> list[tuple[np.ndarray, np.ndarray]]:
    usable = ~interval_mask(indices, excluded)
    segments: list[tuple[np.ndarray, np.ndarray]] = []
    start: int | None = None
    for position in range(len(indices) + 1):
        valid = position < len(indices) and usable[position]
        follows = position > 0 and position < len(indices) and indices[position] == indices[position - 1] + 1
        if valid and (start is None or not follows):
            if start is not None:
                segments.append((indices[start:position], values[start:position]))
            start = position
        elif (not valid or position == len(indices)) and start is not None:
            segments.append((indices[start:position], values[start:position]))
            start = None
    return [(segment_indices, segment_values) for segment_indices, segment_values in segments if len(segment_values)]


def band_power(values: np.ndarray, sample_rate_hz: float, low_hz: float, high_hz: float) -> float:
    if len(values) < 8:
        return float("nan")
    windowed = (values - np.mean(values)) * np.hanning(len(values))
    frequencies = np.fft.rfftfreq(len(windowed), d=1 / sample_rate_hz)
    powers = np.abs(np.fft.rfft(windowed)) ** 2
    selected = (frequencies >= low_hz) & (frequencies < high_hz)
    return float(np.sum(powers[selected]))


def review_intervals(stream: Stream, sample_rate_hz: float) -> list[Interval]:
    intervals: list[Interval] = []
    window_length = round(QUALITY_WINDOW_SECONDS * sample_rate_hz)
    for indices, values in contiguous_segments(stream.sample_indices, stream.values, stream.excluded):
        for start in range(0, len(values), window_length):
            window = values[start : start + window_length]
            if len(window) < sample_rate_hz * 2.5:
                continue
            pulse = band_power(window, sample_rate_hz, 0.5, 12)
            low = band_power(window, sample_rate_hz, 0.05, 0.5)
            high = band_power(window, sample_rate_hz, 12, min(80, sample_rate_hz / 2))
            if pulse > 0 and (low / pulse > MAX_LOW_FREQUENCY_RATIO or high / pulse > MAX_HIGH_FREQUENCY_RATIO):
                intervals.append(Interval(int(indices[start]), int(indices[start + len(window) - 1] + 1), "quality review"))
    return merge_intervals(intervals)


def zero_phase_bandpass(values: np.ndarray, sample_rate_hz: float) -> np.ndarray:
    sos = butter(4, [LOW_CUTOFF_HZ, HIGH_CUTOFF_HZ], btype="bandpass", fs=sample_rate_hz, output="sos")
    # scipy chooses a stable default padding length; very short intervals are not filtered.
    return sosfiltfilt(sos, values) if len(values) > 30 else values.copy()


def shade_intervals(axis: plt.Axes, intervals: list[Interval], sample_rate_hz: float, color: str, label: str) -> None:
    for position, interval in enumerate(intervals):
        axis.axvspan(
            interval.start / sample_rate_hz,
            interval.end / sample_rate_hz,
            color=color,
            alpha=0.22,
            label=label if position == 0 else None,
            linewidth=0,
        )


def plot_overview(streams: list[Stream], sample_rate_hz: float, output_path: Path) -> plt.Figure:
    figure, axes = plt.subplots(len(streams), 1, sharex=True, figsize=(14, 11), constrained_layout=True)
    figure.suptitle("PPG raw recordings with quality-gate overlays", fontsize=15)
    for axis, stream in zip(axes, streams, strict=True):
        # Use NaNs at packet gaps so Matplotlib never draws a false connecting line.
        times = stream.sample_indices / sample_rate_hz
        plotted = stream.values.copy()
        gaps = np.r_[False, np.diff(stream.sample_indices) != 1]
        plotted[gaps] = np.nan
        axis.plot(times, plotted, color="#3465a4", linewidth=0.7, label="raw")
        shade_intervals(axis, stream.excluded, sample_rate_hz, "#7a1f7a", "excluded")
        reviews = review_intervals(stream, sample_rate_hz)
        shade_intervals(axis, reviews, sample_rate_hz, "#e38d00", "review")
        disposition = (
            "reject full record"
            if any("expected" in issue for issue in stream.issues)
            else "review"
            if stream.excluded or reviews
            else "eligible"
        )
        axis.set_title(f"{stream.identifier} — {disposition}", loc="left", fontsize=11, fontweight="bold")
        axis.set_ylabel("a.u.")
        axis.grid(alpha=0.25)
        if stream.issues:
            axis.text(0.995, 0.9, "; ".join(stream.issues), transform=axis.transAxes, ha="right", va="top", fontsize=8)
    axes[-1].set_xlabel("time (s)")
    figure.legend(
        handles=[
            plt.Line2D([], [], color="#3465a4", linewidth=1, label="raw"),
            Patch(facecolor="#7a1f7a", alpha=0.22, label="excluded"),
            Patch(facecolor="#e38d00", alpha=0.22, label="review"),
        ],
        loc="upper right",
        ncols=3,
    )
    figure.savefig(output_path, dpi=180)
    return figure


def plot_s4_comparison(stream: Stream, sample_rate_hz: float, output_path: Path) -> plt.Figure:
    segments = contiguous_segments(stream.sample_indices, stream.values, stream.excluded)
    figure, axes = plt.subplots(2, 1, sharex=True, figsize=(14, 7), constrained_layout=True)
    figure.suptitle("S4: raw signal versus zero-phase 0.4–12 Hz band-pass", fontsize=15)
    for indices, values in segments:
        times = indices / sample_rate_hz
        axes[0].plot(times, values, color="#3465a4", linewidth=0.7)
        axes[1].plot(times, zero_phase_bandpass(values, sample_rate_hz), color="#18855b", linewidth=0.8)
    for axis, title in zip(axes, ("Raw S4", "Filtered S4"), strict=True):
        shade_intervals(axis, review_intervals(stream, sample_rate_hz), sample_rate_hz, "#e38d00", "quality review")
        axis.set_title(title, loc="left", fontsize=11, fontweight="bold")
        axis.set_ylabel("a.u.")
        axis.grid(alpha=0.25)
    axes[-1].set_xlabel("time (s)")
    figure.savefig(output_path, dpi=180)
    return figure


def main() -> None:
    arguments = parse_arguments()
    document = json.loads(arguments.input.read_text(encoding="utf-8"))
    sample_rate_hz = float(document["sampling_rate_hz"])
    streams = [reconstruct_stream(recording, document["expected_samples_per_recording"]) for recording in document["recordings"]]
    arguments.output_dir.mkdir(parents=True, exist_ok=True)
    overview_path = arguments.output_dir / "ppg_quality_overview.png"
    s4_path = arguments.output_dir / "s4_filter_comparison.png"
    overview_figure = plot_overview(streams, sample_rate_hz, overview_path)
    s4 = next(stream for stream in streams if stream.identifier == "S4")
    s4_figure = plot_s4_comparison(s4, sample_rate_hz, s4_path)
    print(f"Wrote {overview_path.resolve()}")
    print(f"Wrote {s4_path.resolve()}")
    if arguments.show:
        print("Opening the two Matplotlib figure windows. Close them to end the command.")
        plt.show()
    else:
        plt.close(overview_figure)
        plt.close(s4_figure)


if __name__ == "__main__":
    main()
