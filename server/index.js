'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { analyzeDocument, validateAndReconstruct, contiguousUsableSegments, zeroPhaseBandPass } = require('../src/pipeline');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.API_PORT ?? 3001);
let cached = null;

function inputCandidates() {
  return [
    process.env.PPG_INPUT_PATH,
    path.join(root, 'data', 'case-data.json'),
    path.resolve(root, '..', '..', 'MayaCardio_Signal_Processing_Case_Data_ppg.json')
  ].filter(Boolean);
}

function loadDocument() {
  const inputPath = inputCandidates().find((candidate) => fs.existsSync(candidate));
  if (!inputPath) {
    throw new Error('No input JSON found. Set PPG_INPUT_PATH or place the source at data/case-data.json.');
  }
  const modified = fs.statSync(inputPath).mtimeMs;
  if (!cached || cached.inputPath !== inputPath || cached.modified !== modified) {
    const document = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    cached = { inputPath, modified, document, report: analyzeDocument(document) };
  }
  return cached;
}

function decimate(values, startSample, samplingRateHz, maximumPoints = 1800) {
  const stride = Math.max(1, Math.ceil(values.length / maximumPoints));
  const output = [];
  for (let index = 0; index < values.length; index += stride) {
    output.push([Number(((startSample + index) / samplingRateHz).toFixed(4)), Number(values[index].toFixed(6))]);
  }
  if ((values.length - 1) % stride !== 0) {
    const index = values.length - 1;
    output.push([Number(((startSample + index) / samplingRateHz).toFixed(4)), Number(values[index].toFixed(6))]);
  }
  return output;
}

function splitPacketSegments(samples) {
  const result = [];
  let current = [];
  for (const sample of samples) {
    if (current.length && sample.sampleIndex !== current.at(-1).sampleIndex + 1) {
      result.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length) result.push(current);
  return result;
}

function waveform(recordingId) {
  const { document, report } = loadDocument();
  const recording = document.recordings.find((item) => item.recording_id === recordingId);
  const reportRecording = report.recordings.find((item) => item.recordingId === recordingId);
  if (!recording || !reportRecording) return null;
  const config = report.pipeline.configuration;
  const reconstruction = validateAndReconstruct(recording, document.sampling_rate_hz, config);
  const rawSegments = splitPacketSegments(reconstruction.samples).map((segment) => decimate(
    segment.map((sample) => sample.value), segment[0].sampleIndex, document.sampling_rate_hz
  ));
  const minimumLength = Math.round(config.minimumUsableSeconds * document.sampling_rate_hz);
  const usableSegments = contiguousUsableSegments(reconstruction.samples, reconstruction.invalidIntervals, minimumLength);
  const filteredSegments = usableSegments.map((segment) => decimate(
    zeroPhaseBandPass(segment.values, document.sampling_rate_hz, config), segment.startSample, document.sampling_rate_hz
  ));
  const rawAtlasReviewBeats = reportRecording.usableSegments.flatMap((segment) => (
    segment.rawBeatAtlas?.beats
      ?.filter((beat) => beat.verdict === 'review')
      .map((beat) => ({ timeSeconds: (segment.startSample + beat.peakOffsetSamples) / document.sampling_rate_hz, dtwDistance: beat.dtwDistance })) ?? []
  ));
  return {
    recordingId,
    rawSegments,
    filteredSegments,
    excludedIntervals: reportRecording.excludedIntervals,
    reviewWindows: reportRecording.usableSegments.flatMap((segment) => segment.windows.filter((window) => window.verdict === 'review')),
    rawAtlasReviewBeats,
    durationSeconds: document.duration_s,
    samplingRateHz: document.sampling_rate_hz
  };
}

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method !== 'GET') return send(response, 405, { error: 'Only GET is supported.' });
    if (pathname === '/api/health') return send(response, 200, { status: 'ok' });
    if (pathname === '/api/report') return send(response, 200, loadDocument().report);
    const match = pathname.match(/^\/api\/waveform\/([A-Za-z0-9_-]+)$/);
    if (match) {
      const result = waveform(match[1]);
      return result ? send(response, 200, result) : send(response, 404, { error: 'Recording not found.' });
    }
    return send(response, 404, { error: 'Endpoint not found.' });
  } catch (error) {
    return send(response, 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`PPG API listening at http://127.0.0.1:${port}`);
  console.log(`Input candidates: ${inputCandidates().join(' | ')}`);
});
