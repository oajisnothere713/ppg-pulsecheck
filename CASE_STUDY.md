# PPG signal-processing case study: first evidence draft

This document describes signal and data-quality observations only. It does not diagnose a person, validate a medical device, or establish a physiological ground truth.

## Reproducible evidence

Generate the report and figures from the supplied JSON:

```powershell
npm test
npm run analyze -- --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output analysis-report.json
npm run visualize -- --input "C:\Users\insti\Desktop\MayaCardio_Signal_Processing_Case_Data_ppg.json" --output visual-report.html
```

`visual-report.html` shows all raw streams, the excluded intervals, quality-review windows, and the S4 before/after comparison. `analysis-report.json` holds the exact numerical audit trail.

## Q1A — Observations and hypotheses

| Stream | Observed evidence | Effect on measurements | Provisional disposition |
|---|---|---|---|
| S1 | Packet metadata is continuous, but samples from 29.745–29.955 s are identical. | A repeated-value segment can create or remove a peak and distort the final pulse width/area. | Review; withhold that interval and retain the preceding contiguous data. |
| S2 | Packet metadata is continuous. Its additional energy is low frequency (dominant difference from S1 around 0.17 Hz). | Baseline movement can alter area, amplitude, and threshold-based pulse detection more than it alters well-separated timing. | Accept for the defined timing task after baseline removal; report the limitation for amplitude/area. |
| S3 | Packet metadata is continuous, but 35–60 Hz content causes all six five-second windows to exceed the high-frequency gate. Raw peak detection finds 40 candidates; filtering finds 36. | Fast contamination can introduce false local maxima and change apparent pulse height/width. | Review; use only after documented filtering and beat-level confirmation. |
| S4 | Packet metadata is continuous, with periodic 20 Hz and 60 Hz components. Raw detection finds 41 peaks; the filtered trace finds 36. | Periodic interference can be counted as pulses or deform pulse morphology. | Review; selected for the before/after filter demonstration. |
| S5 | 5,800 rather than 6,000 samples; packet sequence jumps from 19 to 22; indices 2,000–2,199 (10–11 s) are absent. It also has repeated-value runs at 18.5–18.6 s, 19.255–19.475 s, and 29.745–29.955 s. | Missing samples invalidate any whole-record timing, rate, area, or morphology claim across the gap. | Reject as a complete recording. Analyse only explicitly separated valid segments if needed. |

### Competing explanations and smallest discriminating tests

For the low-frequency movement in S2, two plausible explanations are changing sensor contact/ambient light and a genuine slow optical change. A simultaneous accelerometer/ambient-light channel, or a controlled stationary/dark capture, would distinguish them: coupling to movement or light supports artifact; persistence under stable control conditions weakens that explanation.

For the 20/60 Hz features in S4, periodic electronic pickup and periodic mechanical motion are both plausible. The smallest useful test is a stationary, controlled-input acquisition while recording a reference electrical or ambient-light channel. Persistence at the same frequency without motion supports pickup; coherence with the motion reference supports mechanical artifact.

For S1/S5 repeated values, a transport/firmware hold and ADC saturation are competing explanations. Inspect raw ADC codes and the packet/buffer log: a rail value supports saturation, while an ordinary repeated code together with packet/buffer anomalies supports a handling fault.

## Q1B — Chosen mitigation: S4 zero-phase FIR band-pass

### Method and expectation

S4 is selected because individual pulses remain visible but the periodic 20 Hz and 60 Hz components create extra local maxima. The pipeline uses a symmetric, zero-phase, windowed-sinc FIR band-pass of 0.4–12 Hz (401 taps). The lower edge reduces baseline movement; the upper edge reduces the 20/60 Hz disturbance. Reflection is used at the segment edges, and the report labels the method and every parameter.

The expected result is fewer non-physiological local maxima with little change in the timing of retained peaks. The method is not expected to preserve every high-frequency morphology feature; therefore pulse height, width, and area must be compared rather than assumed unchanged.

### Measured comparison

| Measure | Raw S4 | Filtered S4 | Interpretation |
|---|---:|---:|---|
| Detected peaks | 41 | 36 | The raw trace contains five extra candidates consistent with periodic interference. |
| Median peak rate | 75.00 bpm | 71.86 bpm | The raw estimate is sensitive to the extra candidates. |
| Median matched-peak timing shift | — | 15 ms | Retained peak times are close enough for a timing-focused engineering comparison, but not proof of physiological validity. |
| Median pulse height | 1.9585 a.u. | 1.5277 a.u. | Amplitude is materially affected; do not claim amplitude preservation. |
| Median half-height width | 0.230 s | 0.2875 s | Width is materially affected; do not claim morphology preservation. |

The approach would be considered unsuccessful for a timing use case if the accepted peak count became unstable, if matched peak shifts became large relative to the required timing precision, or if peaks near window edges dominated the result. An additional check is manual or independently coded beat matching on several clean and contaminated windows, ideally against a reference channel.

## Q1C — Sampling and spectrum thought experiment

At a 200 Hz sample rate, the Nyquist frequency is 100 Hz. Useful 0–30 Hz content, a 10 Hz disturbance, and 8–12 Hz motion sidebands all appear at their true frequencies below Nyquist. The 8–12 Hz region overlaps potentially useful signal content, so a blanket 10 Hz notch can also remove pulse-shape information.

Any analog component above 100 Hz aliases into the sampled band when no anti-alias filter exists. For example, 190 Hz and 210 Hz both fold to an observed 10 Hz component. Once folded, software cannot determine whether an observed 10 Hz component was true 10 Hz or an alias. The priority is therefore an analog low-pass anti-alias filter before the ADC, passing the required 0–30 Hz band and strongly attenuating frequencies above 100 Hz. Digital filters then address residual in-band artifact, but cannot repair aliasing.

## Case 2 — Trace the fault through the system

The signal evidence does not establish whether hardware or software is solely at fault. The first three checks should be:

1. **Packet/timestamp integrity:** verify sequence numbers, first sample indices, packet sizes, duplicated samples, and sample totals. This immediately detects S5’s one-second missing interval and prevents invalid downstream measurement.
2. **Raw sensor/analog/ADC capture:** inspect dark or controlled-reference recordings, rail-code counts, gain settings, supply/reference behavior, and raw conversion codes. This separates front-end/ADC problems from later processing.
3. **Cross-channel spectral experiment:** compare the PPG with accelerometer, ambient-light, and electrical reference channels while stationary and during controlled motion. This tests whether the periodic features are mechanical, optical, or electronic.

No valid measurement should be reported across missing samples, repeated-value intervals, or unreviewed high-frequency contamination. A reasonable near-term system improvement is to preserve per-packet integrity metadata and log raw diagnostic channels alongside the PPG stream; that turns uncertain attribution into a testable engineering question.

## Short judgment situations

**A.** A low-quality tag is more valuable than a deceptively tidy display when it prevents a questionable segment from becoming a reported measurement. I would recommend showing the raw signal with the quality overlay, the excluded interval, and the reason, then demonstrate the filtered trace only as an explicitly conditional result.

**B.** If difficult samples were removed from the comparison, the claimed filter improvement may be selection bias. I would repeat the comparison on the identical, predeclared valid windows and report both coverage and failures; if the benefit disappears, update the conclusion to “filtering helps only on selected windows,” not “filtering improves timing.”

## Tool disclosure

This draft and the dependency-free Node.js analysis/visualization code were created with Codex assistance. The evidence claims are tied to reproducible scripts and the supplied JSON; the interpretation, threshold selection, and any final submission should be independently reviewed and adapted by the project team.
