'use strict';

const DEFAULTS = Object.freeze({
  minimumUsableSeconds: 2.5,
  flatlineMinimumSamples: 10,
  flatlineTolerance: 1e-10,
  lowCutoffHz: 0.4,
  highCutoffHz: 12,
  firTaps: 401,
  qualityWindowSeconds: 5,
  maximumHighFrequencyRatio: 0.05,
  maximumLowFrequencyRatio: 0.35,
  maximumDerivativeOutlierRatio: 20,
  peakMinimumDistanceSeconds: 0.4,
  peakProminenceFraction: 0.15
});

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values) {
  const average = mean(values);
  if (average === null) return null;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
      previous.reasons = [...new Set([...previous.reasons, ...interval.reasons])];
    } else {
      merged.push({ ...interval, reasons: [...interval.reasons] });
    }
  }
  return merged;
}

function findFlatlines(samples, tolerance, minimumSamples) {
  const intervals = [];
  let start = 0;
  for (let index = 1; index <= samples.length; index += 1) {
    const continues = index < samples.length && Math.abs(samples[index].value - samples[index - 1].value) <= tolerance;
    if (continues) continue;
    if (index - start >= minimumSamples) {
      intervals.push({
        start: samples[start].sampleIndex,
        end: samples[index - 1].sampleIndex + 1,
        reasons: ['flatline']
      });
    }
    start = index;
  }
  return intervals;
}

/**
 * Validates packet metadata and reconstructs the supplied samples without
 * inventing values for gaps. Packet order is retained because a sequence
 * number is an acquisition fact, not a sortable suggestion.
 */
function validateAndReconstruct(recording, samplingRateHz, config) {
  const issues = [];
  const samples = [];
  const invalidIntervals = [];
  let previous = null;

  for (const [position, packet] of recording.packets.entries()) {
    const values = Array.isArray(packet.values) ? packet.values : [];
    if (packet.sample_count !== values.length) {
      issues.push({ type: 'packet_count_mismatch', packetPosition: position, declared: packet.sample_count, actual: values.length });
    }
    if (previous) {
      const expectedSequence = previous.sequence + 1;
      const expectedIndex = previous.first_sample_index + previous.sample_count;
      if (packet.sequence !== expectedSequence) {
        issues.push({ type: 'sequence_discontinuity', packetPosition: position, expected: expectedSequence, observed: packet.sequence });
      }
      if (packet.first_sample_index !== expectedIndex) {
        issues.push({ type: 'sample_index_discontinuity', packetPosition: position, expected: expectedIndex, observed: packet.first_sample_index });
        if (packet.first_sample_index > expectedIndex) {
          invalidIntervals.push({
            start: expectedIndex,
            end: packet.first_sample_index,
            reasons: ['missing_packet_samples']
          });
        }
      }
    }

    values.forEach((value, offset) => {
      if (!Number.isFinite(value)) {
        issues.push({ type: 'non_finite_sample', packetPosition: position, offset });
        return;
      }
      samples.push({ sampleIndex: packet.first_sample_index + offset, value });
    });
    previous = packet;
  }

  const flatlines = findFlatlines(samples, config.flatlineTolerance, config.flatlineMinimumSamples);
  invalidIntervals.push(...flatlines);
  const expectedSamples = recording.expected_samples ?? null;
  return {
    samples,
    issues,
    invalidIntervals: mergeIntervals(invalidIntervals),
    expectedSamples,
    samplingRateHz
  };
}

function isInvalid(index, intervals) {
  return intervals.some((interval) => index >= interval.start && index < interval.end);
}

function contiguousUsableSegments(samples, invalidIntervals, minimumLength) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (current.length >= minimumLength) {
      segments.push({
        startSample: current[0].sampleIndex,
        endSample: current.at(-1).sampleIndex + 1,
        values: current.map((sample) => sample.value)
      });
    }
    current = [];
  };

  for (const sample of samples) {
    const followsCurrent = current.length && sample.sampleIndex === current.at(-1).sampleIndex + 1;
    if (isInvalid(sample.sampleIndex, invalidIntervals) || (current.length && !followsCurrent)) {
      flush();
    }
    if (!isInvalid(sample.sampleIndex, invalidIntervals)) current.push(sample);
  }
  flush();
  return segments;
}

function nextPowerOfTwo(value) {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}

function fft(real, imaginary) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let block = 2; block <= length; block <<= 1) {
    const angle = -2 * Math.PI / block;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let start = 0; start < length; start += block) {
      let realWeight = 1;
      let imaginaryWeight = 0;
      const half = block >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const evenReal = real[start + offset];
        const evenImaginary = imaginary[start + offset];
        const oddReal = real[start + offset + half] * realWeight - imaginary[start + offset + half] * imaginaryWeight;
        const oddImaginary = real[start + offset + half] * imaginaryWeight + imaginary[start + offset + half] * realWeight;
        real[start + offset] = evenReal + oddReal;
        imaginary[start + offset] = evenImaginary + oddImaginary;
        real[start + offset + half] = evenReal - oddReal;
        imaginary[start + offset + half] = evenImaginary - oddImaginary;
        const nextRealWeight = realWeight * cosine - imaginaryWeight * sine;
        imaginaryWeight = realWeight * sine + imaginaryWeight * cosine;
        realWeight = nextRealWeight;
      }
    }
  }
}

function spectrum(values, samplingRateHz) {
  const length = nextPowerOfTwo(values.length);
  const average = mean(values) ?? 0;
  const real = Array(length).fill(0);
  const imaginary = Array(length).fill(0);
  values.forEach((value, index) => {
    const window = values.length > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (values.length - 1)) : 1;
    real[index] = (value - average) * window;
  });
  fft(real, imaginary);
  return real.slice(1, (length >> 1) + 1).map((value, index) => ({
    frequencyHz: ((index + 1) * samplingRateHz) / length,
    power: value ** 2 + imaginary[index + 1] ** 2
  }));
}

function bandPower(powerSpectrum, lowerHz, upperHz) {
  return powerSpectrum
    .filter(({ frequencyHz }) => frequencyHz >= lowerHz && frequencyHz < upperHz)
    .reduce((total, { power }) => total + power, 0);
}

function derivativeOutlierRatio(values) {
  const changes = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  const typical = median(changes);
  if (!typical || typical <= Number.EPSILON) return Infinity;
  return Math.max(...changes) / typical;
}

function qualityMetrics(values, samplingRateHz) {
  const powerSpectrum = spectrum(values, samplingRateHz);
  const pulseBand = bandPower(powerSpectrum, 0.5, 12);
  const lowBand = bandPower(powerSpectrum, 0.05, 0.5);
  const highBand = bandPower(powerSpectrum, 12, Math.min(80, samplingRateHz / 2));
  return {
    lowFrequencyRatio: pulseBand ? lowBand / pulseBand : Infinity,
    highFrequencyRatio: pulseBand ? highBand / pulseBand : Infinity,
    derivativeOutlierRatio: derivativeOutlierRatio(values),
    standardDeviation: standardDeviation(values)
  };
}

function designLowPassFir(cutoffHz, samplingRateHz, requestedTaps) {
  let taps = requestedTaps % 2 === 0 ? requestedTaps + 1 : requestedTaps;
  const normalizedCutoff = cutoffHz / samplingRateHz;
  const middle = (taps - 1) / 2;
  const coefficients = Array.from({ length: taps }, (_, index) => {
    const distance = index - middle;
    const ideal = distance === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * distance) / (Math.PI * distance);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (taps - 1));
    return ideal * hamming;
  });
  const coefficientSum = coefficients.reduce((total, coefficient) => total + coefficient, 0);
  return coefficients.map((coefficient) => coefficient / coefficientSum);
}

function reflectIndex(index, length) {
  if (length === 1) return 0;
  let reflected = index;
  while (reflected < 0 || reflected >= length) {
    reflected = reflected < 0 ? -reflected - 1 : (2 * length) - reflected - 1;
  }
  return reflected;
}

/** A symmetric centred FIR has zero phase; reflection avoids edge zero-padding. */
function zeroPhaseFir(values, coefficients) {
  const middle = Math.floor(coefficients.length / 2);
  return values.map((_, outputIndex) => coefficients.reduce((total, coefficient, coefficientIndex) => {
    const inputIndex = reflectIndex(outputIndex + coefficientIndex - middle, values.length);
    return total + coefficient * values[inputIndex];
  }, 0));
}

function zeroPhaseBandPass(values, samplingRateHz, config) {
  const high = zeroPhaseFir(values, designLowPassFir(config.highCutoffHz, samplingRateHz, config.firTaps));
  const low = zeroPhaseFir(values, designLowPassFir(config.lowCutoffHz, samplingRateHz, config.firTaps));
  return high.map((value, index) => value - low[index]);
}

function localMinimum(values, start, end) {
  let result = Infinity;
  for (let index = Math.max(0, start); index <= Math.min(values.length - 1, end); index += 1) result = Math.min(result, values[index]);
  return result;
}

function findPeaks(values, samplingRateHz, config) {
  const minimumDistance = Math.round(config.peakMinimumDistanceSeconds * samplingRateHz);
  const range = Math.max(...values) - Math.min(...values);
  const prominenceThreshold = range * config.peakProminenceFraction;
  const candidates = [];
  for (let index = 1; index < values.length - 1; index += 1) {
    if (values[index] < values[index - 1] || values[index] < values[index + 1]) continue;
    const baseline = localMinimum(values, index - minimumDistance, index);
    if (values[index] - baseline >= prominenceThreshold) candidates.push(index);
  }
  const peaks = [];
  for (const candidate of candidates) {
    const previous = peaks.at(-1);
    if (previous === undefined || candidate - previous >= minimumDistance) {
      peaks.push(candidate);
    } else if (values[candidate] > values[previous]) {
      peaks[peaks.length - 1] = candidate;
    }
  }
  return peaks;
}

function pulseMetrics(values, peaks, samplingRateHz) {
  const pulses = peaks.map((peak) => {
    const left = Math.max(0, peak - Math.round(samplingRateHz));
    const trough = localMinimum(values, left, peak);
    const height = values[peak] - trough;
    const halfHeight = trough + height / 2;
    let leftCrossing = peak;
    let rightCrossing = peak;
    while (leftCrossing > left && values[leftCrossing] > halfHeight) leftCrossing -= 1;
    while (rightCrossing < values.length - 1 && values[rightCrossing] > halfHeight) rightCrossing += 1;
    return { peakOffsetSamples: peak, height, widthSeconds: (rightCrossing - leftCrossing) / samplingRateHz };
  });
  const intervals = peaks.slice(1).map((peak, index) => (peak - peaks[index]) / samplingRateHz);
  const bpm = intervals.filter((interval) => interval > 0).map((interval) => 60 / interval);
  return {
    pulseCount: pulses.length,
    medianBpm: round(median(bpm), 2),
    medianHeight: round(median(pulses.map((pulse) => pulse.height)), 4),
    medianWidthSeconds: round(median(pulses.map((pulse) => pulse.widthSeconds)), 4),
    pulses: pulses.map((pulse) => ({ ...pulse, height: round(pulse.height), widthSeconds: round(pulse.widthSeconds) }))
  };
}

function comparePeakLocations(before, after, samplingRateHz) {
  if (!before.length || !after.length) return { matchedPeaks: 0, medianTimingShiftMilliseconds: null };
  const shifts = before.map((peak) => Math.min(...after.map((other) => Math.abs(other - peak))));
  return {
    matchedPeaks: Math.min(before.length, after.length),
    medianTimingShiftMilliseconds: round((median(shifts) / samplingRateHz) * 1000, 2)
  };
}

function assessWindow(values, samplingRateHz, config) {
  const metrics = qualityMetrics(values, samplingRateHz);
  const reasons = [];
  if (metrics.lowFrequencyRatio > config.maximumLowFrequencyRatio) reasons.push('excess_low_frequency_energy');
  if (metrics.highFrequencyRatio > config.maximumHighFrequencyRatio) reasons.push('excess_high_frequency_energy');
  if (metrics.derivativeOutlierRatio > config.maximumDerivativeOutlierRatio) reasons.push('impulsive_derivative_outlier');
  return { metrics, reasons };
}

function analyzeSegment(segment, samplingRateHz, config) {
  const windowLength = Math.round(config.qualityWindowSeconds * samplingRateHz);
  const windows = [];
  for (let start = 0; start < segment.values.length; start += windowLength) {
    const values = segment.values.slice(start, Math.min(start + windowLength, segment.values.length));
    if (values.length < Math.round(samplingRateHz * config.minimumUsableSeconds)) continue;
    const assessment = assessWindow(values, samplingRateHz, config);
    windows.push({
      startSample: segment.startSample + start,
      endSample: segment.startSample + start + values.length,
      verdict: assessment.reasons.length ? 'review' : 'accepted',
      reasons: assessment.reasons,
      metrics: Object.fromEntries(Object.entries(assessment.metrics).map(([key, value]) => [key, round(value)]))
    });
  }
  const filtered = zeroPhaseBandPass(segment.values, samplingRateHz, config);
  const rawPeaks = findPeaks(segment.values, samplingRateHz, config);
  const filteredPeaks = findPeaks(filtered, samplingRateHz, config);
  return {
    startSample: segment.startSample,
    endSample: segment.endSample,
    durationSeconds: round(segment.values.length / samplingRateHz, 3),
    windows,
    preprocessing: {
      method: 'zero_phase_windowed_sinc_fir_bandpass',
      lowCutoffHz: config.lowCutoffHz,
      highCutoffHz: config.highCutoffHz,
      taps: config.firTaps
    },
    before: pulseMetrics(segment.values, rawPeaks, samplingRateHz),
    after: pulseMetrics(filtered, filteredPeaks, samplingRateHz),
    comparison: comparePeakLocations(rawPeaks, filteredPeaks, samplingRateHz)
  };
}

function analyzeRecording(recording, document, config) {
  const samplingRateHz = document.sampling_rate_hz;
  const reconstruction = validateAndReconstruct(recording, samplingRateHz, config);
  const expected = document.expected_samples_per_recording;
  if (reconstruction.samples.length !== expected) {
    reconstruction.issues.push({ type: 'recording_sample_total_mismatch', expected, observed: reconstruction.samples.length });
  }
  const minimumLength = Math.round(config.minimumUsableSeconds * samplingRateHz);
  const segments = contiguousUsableSegments(reconstruction.samples, reconstruction.invalidIntervals, minimumLength);
  const segmentReports = segments.map((segment) => analyzeSegment(segment, samplingRateHz, config));
  const hasMissingData = reconstruction.invalidIntervals.some((interval) => interval.reasons.includes('missing_packet_samples'));
  const hasIntegrityFailure = reconstruction.issues.some((issue) => ['sequence_discontinuity', 'sample_index_discontinuity', 'recording_sample_total_mismatch'].includes(issue.type));
  const requiresReview = segmentReports.some((segment) => segment.windows.some((window) => window.verdict === 'review'));
  const verdict = hasMissingData || hasIntegrityFailure ? 'rejected_as_full_recording' : requiresReview || reconstruction.invalidIntervals.length ? 'review' : 'accepted';
  return {
    recordingId: recording.recording_id,
    verdict,
    samplingRateHz,
    rawSampleCount: reconstruction.samples.length,
    expectedSampleCount: expected,
    issues: reconstruction.issues,
    excludedIntervals: reconstruction.invalidIntervals.map((interval) => ({
      ...interval,
      startSeconds: round(interval.start / samplingRateHz, 3),
      endSeconds: round(interval.end / samplingRateHz, 3)
    })),
    usableSegments: segmentReports,
    limitations: [
      'The pipeline does not interpolate missing samples or convert rejected intervals into pulse measurements.',
      'Quality thresholds are engineering defaults and must be calibrated against labelled reference data before clinical use.'
    ]
  };
}

function analyzeDocument(document, overrides = {}) {
  if (!document || !Number.isFinite(document.sampling_rate_hz) || !Array.isArray(document.recordings)) {
    throw new Error('Expected a PPG JSON document with sampling_rate_hz and recordings.');
  }
  const config = { ...DEFAULTS, ...overrides };
  if (config.firTaps % 2 === 0) config.firTaps += 1;
  return {
    pipeline: {
      name: 'quality-gated-ppg-preprocessing',
      version: '0.1.0',
      configuration: config,
      safetyNote: 'This output is an engineering quality assessment, not a diagnosis or clinical decision.'
    },
    source: {
      schemaVersion: document.schema_version ?? null,
      samplingRateHz: document.sampling_rate_hz,
      durationSeconds: document.duration_s ?? null,
      expectedSamplesPerRecording: document.expected_samples_per_recording ?? null
    },
    recordings: document.recordings.map((recording) => analyzeRecording(recording, document, config))
  };
}

module.exports = {
  DEFAULTS,
  analyzeDocument,
  validateAndReconstruct,
  contiguousUsableSegments,
  zeroPhaseBandPass,
  findPeaks,
  qualityMetrics
};
