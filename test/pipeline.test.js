'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, validateAndReconstruct, zeroPhaseBandPass, dynamicTimeWarpingDistance, assessBeatAtlas } = require('../src/pipeline');

function packet(sequence, firstSampleIndex, values) {
  return { sequence, first_sample_index: firstSampleIndex, sample_count: values.length, values };
}

test('packet validation identifies a gap and never fabricates replacement samples', () => {
  const recording = { recording_id: 'gap', packets: [packet(0, 0, [1, 2, 3]), packet(2, 6, [4, 5, 6])] };
  const result = validateAndReconstruct(recording, 10, { flatlineTolerance: 0, flatlineMinimumSamples: 10 });
  assert.equal(result.samples.length, 6);
  assert.deepEqual(result.invalidIntervals, [{ start: 3, end: 6, reasons: ['missing_packet_samples'] }]);
  assert.ok(result.issues.some((issue) => issue.type === 'sequence_discontinuity'));
});

test('flatline samples are excluded as an interval', () => {
  const recording = { recording_id: 'flat', packets: [packet(0, 0, [0, 1, 1, 1, 1, 1, 2])] };
  const result = validateAndReconstruct(recording, 10, { flatlineTolerance: 0, flatlineMinimumSamples: 4 });
  assert.deepEqual(result.invalidIntervals, [{ start: 1, end: 6, reasons: ['flatline'] }]);
});

test('the zero-phase band-pass reduces a 20 Hz component while retaining a 1.2 Hz component', () => {
  const sampleRate = 200;
  const values = Array.from({ length: 2000 }, (_, index) => (
    Math.sin((2 * Math.PI * 1.2 * index) / sampleRate) + 0.4 * Math.sin((2 * Math.PI * 20 * index) / sampleRate)
  ));
  const filtered = zeroPhaseBandPass(values, sampleRate, { lowCutoffHz: 0.4, highCutoffHz: 12, firTaps: 401 });
  const correlation = values.reduce((sum, value, index) => sum + value * filtered[index], 0);
  assert.ok(correlation > 0);
  assert.ok(Math.max(...filtered) - Math.min(...filtered) < Math.max(...values) - Math.min(...values));
});

test('a stream with missing packet samples is rejected as a full recording', () => {
  const document = {
    sampling_rate_hz: 10,
    expected_samples_per_recording: 10,
    recordings: [{ recording_id: 'bad', packets: [packet(0, 0, [0, 1, 0, 1, 0]), packet(2, 7, [1, 0, 1])] }]
  };
  const report = analyzeDocument(document, { minimumUsableSeconds: 0.2, flatlineMinimumSamples: 10, firTaps: 21, qualityWindowSeconds: 0.5 });
  assert.equal(report.recordings[0].verdict, 'rejected_as_full_recording');
});

test('the adaptive beat atlas accepts repeated morphology and reviews a distorted beat', () => {
  const cleanBeat = [0, 0.2, 0.8, 1, 0.6, 0.2, 0];
  const distortedBeat = [0, 0.95, 0.1, 1, 0.15, 0.9, 0];
  assert.equal(dynamicTimeWarpingDistance(cleanBeat, cleanBeat, 0.2), 0);
  const values = [...cleanBeat, ...cleanBeat, ...cleanBeat, ...distortedBeat, ...cleanBeat, ...cleanBeat];
  const peaks = [3, 10, 17, 24, 31, 38];
  const atlas = assessBeatAtlas(values, peaks, 10, {
    beatAtlasLengthSamples: 7,
    beatAtlasWarpFraction: 0.2,
    beatAtlasMinimumDtwThreshold: 0.05,
    beatAtlasMadMultiplier: 2
  });
  assert.equal(atlas.available, true);
  assert.ok(atlas.reviewBeatCount >= 1);
});
