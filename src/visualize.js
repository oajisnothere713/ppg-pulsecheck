'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeDocument, validateAndReconstruct, contiguousUsableSegments, zeroPhaseBandPass } = require('./pipeline');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    if (argv[index] === '--input' || argv[index] === '--output') {
      options[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function decimate(values, startSample, samplingRateHz, maximumPoints) {
  const stride = Math.max(1, Math.ceil(values.length / maximumPoints));
  const points = [];
  for (let index = 0; index < values.length; index += stride) {
    points.push([Number(((startSample + index) / samplingRateHz).toFixed(4)), Number(values[index].toFixed(6))]);
  }
  if ((values.length - 1) % stride !== 0) {
    const index = values.length - 1;
    points.push([Number(((startSample + index) / samplingRateHz).toFixed(4)), Number(values[index].toFixed(6))]);
  }
  return points;
}

function contiguousPacketSegments(samples) {
  const segments = [];
  let current = [];
  for (const sample of samples) {
    if (current.length && sample.sampleIndex !== current.at(-1).sampleIndex + 1) {
      segments.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length) segments.push(current);
  return segments;
}

function buildVisualizationData(document, report) {
  const config = report.pipeline.configuration;
  return {
    samplingRateHz: document.sampling_rate_hz,
    durationSeconds: document.duration_s,
    recordings: document.recordings.map((recording, index) => {
      const audit = report.recordings[index];
      const reconstruction = validateAndReconstruct(recording, document.sampling_rate_hz, config);
      const packetSegments = contiguousPacketSegments(reconstruction.samples).map((samples) => decimate(
        samples.map((sample) => sample.value), samples[0].sampleIndex, document.sampling_rate_hz, 900
      ));
      const usable = contiguousUsableSegments(
        reconstruction.samples,
        reconstruction.invalidIntervals,
        Math.round(config.minimumUsableSeconds * document.sampling_rate_hz)
      );
      const filteredSegments = usable.map((segment) => ({
        raw: decimate(segment.values, segment.startSample, document.sampling_rate_hz, 3000),
        filtered: decimate(
          zeroPhaseBandPass(segment.values, document.sampling_rate_hz, config),
          segment.startSample,
          document.sampling_rate_hz,
          3000
        )
      }));
      return {
        id: recording.recording_id,
        verdict: audit.verdict,
        packetSegments,
        filteredSegments,
        excluded: audit.excludedIntervals,
        reviewWindows: audit.usableSegments.flatMap((segment) => segment.windows.filter((window) => window.verdict === 'review')),
        filteredPulseCount: audit.usableSegments.reduce((sum, segment) => sum + segment.after.pulseCount, 0),
        medianBpm: audit.usableSegments.map((segment) => segment.after.medianBpm).filter(Boolean)
      };
    })
  };
}

function html(data) {
  const safeData = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PPG PulseCheck — Quality-gated visual report</title>
  <style>
    :root { color-scheme: light dark; --bg: #f8fafc; --ink: #102036; --muted: #5d6b7d; --grid: #d8e0ea; --raw: #4c6fff; --filtered: #09865d; --review: #d78600; --reject: #bc3d3d; --exclude: #8f3b89; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111827; --ink: #e7eef8; --muted: #aebbc9; --grid: #334155; --raw: #8aa7ff; --filtered: #49d39b; --review: #ffbc57; --reject: #f88484; --exclude: #e88edd; } }
    * { box-sizing: border-box; }
    body { max-width: 1180px; margin: 0 auto; padding: 28px 18px 48px; background: var(--bg); color: var(--ink); font: 16px/1.45 system-ui, sans-serif; }
    h1 { margin: 0; font-size: 1.7rem; } h2 { margin: 30px 0 10px; font-size: 1.2rem; } p { margin: 6px 0; color: var(--muted); }
    .legend, .summary { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 12px 0; color: var(--muted); font-size: .9rem; }
    .swatch { display: inline-block; width: 12px; height: 12px; margin-right: 5px; vertical-align: -1px; border-radius: 2px; }
    .chart { width: 100%; min-height: 240px; margin: 14px 0 24px; } svg { width: 100%; height: auto; display: block; overflow: visible; } .axis { stroke: var(--grid); stroke-width: 1; } .tick { fill: var(--muted); font-size: 11px; } .label { fill: var(--ink); font-size: 12px; font-weight: 600; } .unit { fill: var(--muted); font-size: 11px; }
    .trace { fill: none; stroke: var(--raw); stroke-width: 1.1; vector-effect: non-scaling-stroke; } .filtered { fill: none; stroke: var(--filtered); stroke-width: 1.2; vector-effect: non-scaling-stroke; } .review-band { fill: var(--review); opacity: .17; } .excluded-band { fill: var(--exclude); opacity: .26; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; } th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--grid); } th { color: var(--muted); font-size: .85rem; font-weight: 600; } .accepted { color: var(--filtered); } .review { color: var(--review); } .rejected_as_full_recording { color: var(--reject); } .note { font-size: .9rem; }
  </style>
</head>
<body>
  <h1>PPG PulseCheck visual report</h1>
  <p>Raw recordings, excluded intervals, review windows, and an S4 raw-versus-filtered comparison. This is an engineering quality assessment, not a diagnostic interpretation.</p>
  <div class="legend"><span><i class="swatch" style="background:var(--raw)"></i>raw trace</span><span><i class="swatch" style="background:var(--filtered)"></i>filtered trace</span><span><i class="swatch" style="background:var(--review)"></i>review window</span><span><i class="swatch" style="background:var(--exclude)"></i>excluded interval</span></div>
  <h2>All recordings: raw signal and quality overlays</h2>
  <div id="overview"></div>
  <h2>S4: before and after zero-phase band-pass</h2>
  <p class="note">The 0.4–12 Hz filter intentionally reduces high-frequency content. Compare peak timing and count in the JSON audit report before treating this as an improvement.</p>
  <div id="comparison" class="chart"></div>
  <h2>Gate summary</h2>
  <div id="summary"></div>
  <script>
    const data = ${safeData};
    const NS = 'http://www.w3.org/2000/svg';
    const make = (tag, attributes = {}) => { const node = document.createElementNS(NS, tag); Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value)); return node; };
    const extent = (series) => { const values = series.flat().map(point => point[1]); let min = Math.min(...values), max = Math.max(...values); const pad = Math.max((max - min) * .08, .05); return [min - pad, max + pad]; };
    const path = (points, x, y) => points.map((point, index) => (index ? 'L' : 'M') + x(point[0]).toFixed(2) + ',' + y(point[1]).toFixed(2)).join(' ');
    function renderAxis(svg, x, y, width, height, domain, title) {
      const [min, max] = domain; svg.append(make('rect', { x, y, width, height, fill: 'none', class: 'axis' }));
      for (let tick = 0; tick <= 6; tick += 1) { const time = data.durationSeconds * tick / 6; const px = x + width * tick / 6; svg.append(make('line', { x1: px, x2: px, y1: y, y2: y + height, class: 'axis' })); const label = make('text', { x: px, y: y + height + 18, 'text-anchor': 'middle', class: 'tick' }); label.textContent = time.toFixed(0); svg.append(label); }
      for (let tick = 0; tick <= 4; tick += 1) { const value = min + (max - min) * tick / 4; const py = y + height - height * tick / 4; svg.append(make('line', { x1: x, x2: x + width, y1: py, y2: py, class: 'axis' })); const label = make('text', { x: x - 7, y: py + 4, 'text-anchor': 'end', class: 'tick' }); label.textContent = value.toFixed(1); svg.append(label); }
      const xLabel = make('text', { x: x + width / 2, y: y + height + 37, 'text-anchor': 'middle', class: 'unit' }); xLabel.textContent = 'time (s)'; svg.append(xLabel); const yLabel = make('text', { x: 15, y: y + height / 2, transform: 'rotate(-90 15 ' + (y + height / 2) + ')', 'text-anchor': 'middle', class: 'unit' }); yLabel.textContent = 'amplitude (a.u.)'; svg.append(yLabel); const heading = make('text', { x, y: y - 9, class: 'label' }); heading.textContent = title; svg.append(heading);
    }
    function drawOverview() {
      const host = document.getElementById('overview'); host.replaceChildren(); const width = Math.max(host.clientWidth || 760, 320); const panelHeight = 180; const totalHeight = panelHeight * data.recordings.length; const svg = make('svg', { viewBox: '0 0 ' + width + ' ' + totalHeight, role: 'img', 'aria-label': 'Five raw PPG streams with excluded and review intervals' }); const left = 62, right = 16, plotWidth = width - left - right;
      data.recordings.forEach((recording, panel) => { const top = panel * panelHeight + 26, height = 112; const domain = extent(recording.packetSegments); const x = time => left + plotWidth * time / data.durationSeconds; const y = value => top + height - (value - domain[0]) * height / (domain[1] - domain[0]); renderAxis(svg, left, top, plotWidth, height, domain, recording.id + ' — ' + recording.verdict.replaceAll('_', ' ')); recording.reviewWindows.forEach(window => svg.append(make('rect', { x: x(window.startSample / data.samplingRateHz), y: top, width: x(window.endSample / data.samplingRateHz) - x(window.startSample / data.samplingRateHz), height, class: 'review-band' }))); recording.excluded.forEach(interval => svg.append(make('rect', { x: x(interval.startSeconds), y: top, width: x(interval.endSeconds) - x(interval.startSeconds), height, class: 'excluded-band' }))); recording.packetSegments.forEach(segment => svg.append(make('path', { d: path(segment, x, y), class: 'trace' }))); }); host.append(svg);
    }
    function drawComparison() {
      const host = document.getElementById('comparison'); host.replaceChildren(); const recording = data.recordings.find(item => item.id === 'S4'); if (!recording) return; const raw = recording.filteredSegments.map(segment => segment.raw); const filtered = recording.filteredSegments.map(segment => segment.filtered); const width = Math.max(host.clientWidth || 760, 320), height = 270, left = 62, top = 28, bottom = 48, right = 16, plotWidth = width - left - right, plotHeight = height - top - bottom; const svg = make('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'S4 raw and filtered PPG comparison' }); const domain = extent([...raw, ...filtered]); const x = time => left + plotWidth * time / data.durationSeconds; const y = value => top + plotHeight - (value - domain[0]) * plotHeight / (domain[1] - domain[0]); renderAxis(svg, left, top, plotWidth, plotHeight, domain, 'S4 comparison'); raw.forEach(segment => svg.append(make('path', { d: path(segment, x, y), class: 'trace' }))); filtered.forEach(segment => svg.append(make('path', { d: path(segment, x, y), class: 'filtered' }))); host.append(svg);
    }
    const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    function drawSummary() { const rows = data.recordings.map(recording => { const excluded = recording.excluded.length ? recording.excluded.map(interval => interval.startSeconds + '–' + interval.endSeconds + ' s').join(', ') : 'none'; return '<tr><td>' + escapeHtml(recording.id) + '</td><td class="' + escapeHtml(recording.verdict) + '">' + escapeHtml(recording.verdict.replaceAll('_', ' ')) + '</td><td>' + escapeHtml(excluded) + '</td><td>' + recording.reviewWindows.length + '</td><td>' + recording.filteredPulseCount + '</td><td>' + escapeHtml(recording.medianBpm.join(', ') || '—') + '</td></tr>'; }).join(''); document.getElementById('summary').innerHTML = '<table><thead><tr><th>Stream</th><th>Verdict</th><th>Excluded intervals</th><th>Review windows</th><th>Filtered peaks</th><th>Median BPM</th></tr></thead><tbody>' + rows + '</tbody></table>'; }
    function render() { drawOverview(); drawComparison(); drawSummary(); }
    render(); addEventListener('resize', render);
  </script>
</body>
</html>`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.input) {
    console.log('Usage: npm run visualize -- --input <source.json> [--output <visual-report.html>]');
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const document = JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8'));
  const report = analyzeDocument(document);
  const outputPath = path.resolve(options.output ?? 'visual-report.html');
  fs.writeFileSync(outputPath, html(buildVisualizationData(document, report)));
  console.log(`Wrote ${outputPath}`);
}

if (require.main === module) main();

module.exports = { buildVisualizationData, html };
