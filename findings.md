# PPG PulseCheck — methods and findings

## Purpose and scope

This project evaluates the quality of five packetized photoplethysmography (PPG) recordings, S1–S5. Each recording is nominally 30 seconds at 200 Hz (6,000 samples). The outcome is an auditable engineering decision about whether a record is suitable for the defined pulse-timing analysis. It is **not** a clinical diagnosis, a physiological interpretation, or validation of a medical device.

The central design principle is that a clean-looking filtered plot is not enough. Each conclusion must retain the evidence that led to it: packet integrity, excluded samples, quality windows, peak behavior, beat morphology, and the effect of filtering.

## What we built

The repository contains one analysis pipeline and several ways to inspect its output.

| Component | Technology | Role |
|---|---|---|
| Analysis pipeline | Node.js / CommonJS, dependency-free numerical code | Validates packets, finds invalid intervals, filters only usable data, detects peaks, and creates the audit report. |
| Quality gate | Explicit rules in `src/pipeline.js` | Produces `accepted`, `review`, or `rejected_as_full_recording`; it never fills missing data. |
| Beat-atlas check | Adaptive template + constrained dynamic time warping (DTW) | Reviews beats whose normalized shape differs from locally consistent beats. |
| Analysis artifacts | JSON + static HTML | `analysis-report.json` is the machine-readable evidence; `visual-report.html` is a shareable report. |
| Scientific figures | Python, NumPy, SciPy, Matplotlib | Creates raw/filtered overview and S4 comparison figures. |
| Evaluation dashboard | Vite, vanilla JavaScript/CSS, native Node HTTP API, `concurrently` | Presents the same report interactively without hiding a second processing pipeline in the browser. |

The dashboard launches the API and web application together using `npm run dev`. It includes one tab for stream-by-stream waveform inspection and a separate **Findings & comparison** tab for the complete evidence table and conclusions.

## Processing workflow

```text
JSON packets
  → integrity checks
  → invalid-interval detection
  → contiguous usable segments
  → window-level quality gates
  → zero-phase FIR filtering of usable segments only
  → peak and morphology analysis
  → raw-versus-filtered comparison
  → verdict, report, figures, and dashboard
```

### 1. Packet and sample integrity comes first

Before interpreting waveform shape, the pipeline checks sequence numbers, first sample indices, declared packet counts, and the reconstructed sample total. This is necessary because a signal-processing method cannot determine what happened during data that were never acquired or delivered.

If a packet range is missing, the gap is recorded as an excluded interval. The pipeline does not interpolate it or pretend the recording is continuous. That decision protects pulse counts, rates, widths, areas, and morphology from being reported across nonexistent samples.

### 2. Flatlines are marked, not smoothed over

Runs of identical values are treated as possible sensor holds, saturation, or transport/firmware artifacts. They are excluded from measurement rather than being repaired. This retains the usable surrounding data while making the unavailable region visible in the report and dashboard.

### 3. Quality is assessed in windows

Each retained segment is examined in windows for:

- excessive low-frequency energy, which can indicate baseline movement or slow optical drift;
- excessive high-frequency energy, which can create non-physiological local maxima;
- large derivative activity, which can indicate impulsive disturbance.

This is better than one recording-wide score because an artifact can occur briefly while the rest of the trace remains useful. A window with a quality failure is explicitly labelled for review; it is not silently discarded from the evidence.

### 4. Filtering is limited, documented, and zero-phase

The selected mitigation is a 401-tap, windowed-sinc FIR band-pass with a 0.4–12 Hz pass band. It is applied forward and backward (zero-phase) to retained contiguous segments only.

- The **0.4 Hz lower edge** reduces very slow baseline movement.
- The **12 Hz upper edge** reduces the 20 Hz/60 Hz interference visible in the disturbed streams.
- **Zero-phase application** avoids a systematic time delay, which matters when comparing peak timing.
- **Reflection at segment boundaries** reduces edge transients, but boundary results remain an engineering limitation to review.

We did not claim that this filter preserves every pulse-shape feature. Filtering changes amplitude and width, so the project makes a timing-focused claim only where raw and filtered peaks remain closely matched.

### 5. Peak detection is compared before and after filtering

The same peak logic is applied to raw and filtered data. We compare counts, median rate, matched-peak timing, height, and width. A lower peak count is not automatically an improvement: it must agree with quality evidence and show stable retained peak timing.

### 6. An adaptive beat atlas provides a second, different check

The project adds an adaptive local beat atlas rather than relying only on spectral filtering and peak count. Plausibly timed beats are amplitude-normalized and compared with a local template using constrained DTW. Beats whose distance is unusually high are marked for review.

This approach was chosen because periodic interference can create a plausible-looking peak while still producing an abnormal short beat shape. The atlas does not diagnose physiology; it is a data-consistency check that asks whether a candidate resembles neighboring beats in the same recording.

## Findings by stream

The following figures are calculated from `analysis-report.json`. “DTW review” is the number of beat-atlas morphology outliers. Peak shifts are median raw/filtered matched-peak shifts.

| Stream | Quality verdict | Integrity / exclusion evidence | Review windows | Peak candidates, raw → filtered | DTW reviews, raw → filtered | Peak shift | Interpretation |
|---|---|---|---:|---:|---:|---:|---|
| S1 | Review | Flatline excluded at 29.745–29.955 s | 0 | 36 → 36 | 0 → 0 | 5 ms | Most of the record is stable, but the final pulse region is not trustworthy. Do not claim a complete-record result. |
| S2 | Accepted | No integrity issue or excluded interval | 0 | 36 → 36 | 1 → 0 | 5 ms | The strongest complete recording for the defined timing task. |
| S3 | Review | No packet or flatline failure | 6 | 40 → 36 | 3 → 0 | 15 ms | High-frequency contamination produces extra candidates; filtering helps, but the stream remains a reviewed result. |
| S4 | Review | No packet or flatline failure | 6 | 41 → 36 | 4 → 0 | 15 ms | The clearest before/after artifact-mitigation demonstration. |
| S5 | Rejected as full recording | Packet gap at 10–11 s; flatlines at 18.5–18.6 s, 19.255–19.475 s, and 29.745–29.955 s | 0 | 34 → 34 | 0 → 0 | 5 ms per retained segment | Surrounding segments may be described separately, but the missing second invalidates a whole-record result. |

### S1 — late flatline

S1 has continuous packet metadata, but its values become identical near the end. Since an affected final beat can alter peak detection, width, area, and timing, the interval is shown as excluded and the record is held for review. Its stable earlier part is still useful for inspection; the limitation is specifically the full-record conclusion.

### S2 — best complete recording

S2 is the only stream accepted by the quality gate. It has no packet discontinuity, no flatline exclusion, no window-level review, 36 stable filtered peak candidates, and no remaining filtered beat-atlas review. It is therefore the best choice for a full-record, timing-focused measurement under the project’s stated criteria.

S2 is not automatically proof of clinical correctness. It is simply the most internally consistent complete data stream among the supplied recordings.

### S3 — high-frequency contamination

All six analysis windows in S3 exceed the high-frequency quality gate. The raw trace yields 40 peak candidates and three morphology reviews; after filtering it yields 36 candidates and zero morphology reviews. The result supports that high-frequency artifact was producing extra local features, but it remains labelled **review** because the original contamination was present throughout the record.

### S4 — best demonstration of the mitigation

S4 was deliberately selected to demonstrate the filtering decision because individual pulses remain visible while periodic interference creates extra features. Raw detection produces 41 candidates, whereas filtered detection produces 36. The independent beat atlas changes from four reviewed raw beats to zero reviewed filtered beats, and matched retained peaks shift by a median of about 15 ms.

This agreement between peak count, spectrum-oriented quality gate, and morphology atlas is stronger evidence than any one method alone. The conclusion is narrow: the filter improves the timing-oriented representation of this artifact-contaminated record. It does **not** prove that pulse amplitude, width, area, or every morphology feature is preserved.

### S5 — unrecoverable as a complete recording

S5 contains 5,800 samples instead of the nominal 6,000. Packet metadata show a sequence and sample-index discontinuity corresponding to the missing 10–11 second interval. It also contains multiple flatlines. The pipeline keeps the valid segments separate and never calculates a result across the missing second.

No digital filter, DTW method, or visual smoothing can restore unknown samples. S5 is therefore rejected as a full recording even though the retained segments still contain inspectable peaks.

## Comparison and decision logic

Two different “best” labels are useful and should not be conflated:

1. **Best complete recording: S2.** It is the only accepted stream and has no integrity, exclusion, or window-level quality failure.
2. **Best mitigation demonstration: S4 with zero-phase FIR filtering.** It starts with the clearest artifact effect and shows the strongest converging raw-to-filtered change: five fewer peak candidates, four fewer morphology outliers, and small retained-peak timing displacement.

S4 is not selected as the best measurement source because it still began as a contaminated stream and remains correctly tagged for review. This distinction prevents the project from rewarding an impressive-looking filter result over cleaner acquisition data.

## Interactive dashboard evidence

The website makes the report inspectable rather than presenting a single static verdict:

- select a stream to see raw and filtered waveforms together;
- orange bands mark review windows and purple bands mark excluded intervals;
- red markers identify raw beat-atlas morphology outliers;
- hover to read the displayed time, raw amplitude, and filtered amplitude;
- drag or use the mouse wheel to zoom into a region; double-click or use **Reset view** to restore the full trace;
- use **Findings & comparison** to view all streams and the reasoning behind S2 and S4.

The browser requests already computed evidence from the Node API. It does not independently re-filter or re-score data, so the dashboard, static report, and JSON audit trail remain aligned.

## Sampling and system implications

At 200 Hz, the Nyquist frequency is 100 Hz. Useful components up to 30 Hz, an actual 10 Hz disturbance, and 8–12 Hz motion components appear below Nyquist at their original frequencies. However, without an analog anti-alias filter, components above 100 Hz can fold into the sampled band: for example, 190 Hz and 210 Hz both appear at 10 Hz after sampling.

Once aliasing occurs, software cannot determine whether an observed 10 Hz component was truly 10 Hz or an alias. The most important prevention step is therefore an **analog low-pass anti-alias filter before the ADC** that preserves the required PPG band while attenuating frequencies above 100 Hz. The digital pipeline is useful for residual in-band artifact; it cannot repair acquisition-stage aliasing or missing samples.

## Limitations and next checks

- The gate thresholds are transparent engineering defaults, not clinically validated thresholds.
- The records are anonymous and lack physiological ground truth, an accelerometer, ambient-light reference, electrical reference, or labels for true beats.
- A zero-phase offline filter is appropriate for this retrospective analysis but would need a causal alternative for a real-time device.
- Filtered amplitude and width differ from raw values, so the current evidence does not support amplitude- or morphology-preservation claims.
- The DTW atlas identifies local inconsistency, not the physical source of an artifact.

The highest-value next checks would be controlled stationary and motion recordings with accelerometer and ambient-light channels; dark/reference sensor captures; raw ADC and packet-buffer diagnostics; and comparison with labelled reference timing. These checks would distinguish motion, optical, electronic, and transport explanations instead of inferring cause from waveform appearance alone.

## Reproduce the project

From the project folder:

```powershell
npm install
npm test
npm run analyze -- --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output analysis-report.json
npm run dev
```

`npm run dev` starts both the API and the interactive site using `concurrently`; open `http://127.0.0.1:5173` if it does not open automatically. For Python figures:

```powershell
py -m pip install -r requirements.txt
py python\visualize_ppg.py --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output-dir python-output
```

## Final conclusion

The project’s contribution is a **quality-gated, evidence-preserving PPG workflow**, not merely a noise-removal filter. It makes acquisition defects visible, avoids inventing data, limits processing to defensible segments, verifies filter effects using separate morphology evidence, and explains why S2 is the best complete record while S4 is the best demonstration of a timing-focused mitigation. S5 demonstrates the boundary of processing: a missing packet interval must remain a missing packet interval.
