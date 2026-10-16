# PPG PulseCheck

An auditable, quality-gated preprocessing pipeline for packetized PPG streams.
It is an engineering assessment tool, not a diagnostic device.

## What it does

1. Validates packet sequence numbers, sample indices, declared packet lengths, and total sample count.
2. Finds missing packet ranges and flatlined samples and excludes them instead of filling them in.
3. Splits the remaining data into contiguous usable segments.
4. Applies window-level quality gates for excess low-frequency energy, high-frequency energy, and impulsive derivatives.
5. Applies a documented zero-phase, windowed-sinc FIR band-pass (0.4–12 Hz by default) only to usable segments.
6. Compares raw and filtered pulse metrics and writes an inspectable JSON audit report.

The original input file is never modified. A recording with missing packet data is marked `rejected_as_full_recording`, even if valid segments on either side are still described.

## Run

Requires Node.js 20 or later. There are no third-party dependencies.

```powershell
npm test
npm run analyze -- --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output analysis-report.json
npm run visualize -- --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output visual-report.html
```

Open `visual-report.html` in a browser to inspect all raw streams, every excluded interval and review window, and the S4 before/after filtering comparison.

`CASE_STUDY.md` is the evidence-backed first draft for the written sections of the supplied case brief. It is deliberately explicit about which conclusions are data-quality findings and which need further controlled testing.

## Python visualizations

The dependency-free Node visualization remains available above. If you prefer a Python scientific stack, install Python 3.10+ and then run:

```powershell
py -m pip install -r requirements.txt
py python\visualize_ppg.py --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output-dir python-output
```

This command saves `python-output\ppg_quality_overview.png` and `python-output\s4_filter_comparison.png`, then opens both Matplotlib windows automatically. Close the windows to end the command. For batch or headless runs, add `--no-show`.

## Interpreting the report

- `issues` records acquisition/transport facts such as sequence gaps and incorrect sample totals.
- `excludedIntervals` gives exact sample and time spans that were withheld from measurement.
- `usableSegments[].windows` is the quality-gate decision with numerical evidence and reasons.
- `before`, `after`, and `comparison` make the filtering effect measurable rather than assumed.

The included threshold values are starting engineering defaults. They must be tuned and validated against labelled reference data before any clinical or production decision is based on them.
