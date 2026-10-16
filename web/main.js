import './styles.css';

const API = 'http://127.0.0.1:3001/api';
const app = document.querySelector('#app');
let report;
let activeRecording;
let activeView = 'dashboard';
let activeWaveform;
let waveformView;
let dragState;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function verdictLabel(verdict) {
  return verdict.replaceAll('_', ' ');
}

function totalAtlasReviews(recording, field) {
  return recording.usableSegments.reduce((total, segment) => total + (segment[field]?.reviewBeatCount ?? 0), 0);
}

function statusCard(label, value, modifier = '') {
  return `<article class="stat ${modifier}"><span>${label}</span><strong>${value}</strong></article>`;
}

function renderShell() {
  const accepted = report.recordings.filter((item) => item.verdict === 'accepted').length;
  const review = report.recordings.filter((item) => item.verdict === 'review').length;
  const rejected = report.recordings.filter((item) => item.verdict.startsWith('rejected')).length;
  app.innerHTML = `
    <main>
      <header class="hero">
        <div>
          <p class="eyebrow">Signal quality evaluation</p>
          <h1>PPG PulseCheck</h1>
          <p class="subtitle">An auditable quality gate for packetized PPG. Results are engineering evidence, not clinical diagnosis.</p>
        </div>
        <div class="source"><span>Source</span><strong>${report.source.samplingRateHz} Hz · ${report.source.durationSeconds} s</strong></div>
      </header>
      <section class="stats" aria-label="Recording verdicts">
        ${statusCard('Accepted', accepted, 'accepted')}
        ${statusCard('Review', review, 'review')}
        ${statusCard('Rejected', rejected, 'rejected')}
        ${statusCard('Recordings', report.recordings.length)}
      </section>
      <nav class="tabs" aria-label="Evaluation views">
        <button class="tab ${activeView === 'dashboard' ? 'active' : ''}" data-view="dashboard" type="button">Signal dashboard</button>
        <button class="tab ${activeView === 'findings' ? 'active' : ''}" data-view="findings" type="button">Findings & comparison</button>
      </nav>
      <div id="page-content"></div>
    </main>`;
  app.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    activeView = button.dataset.view;
    renderShell();
  }));
  renderView();
}

function renderView() {
  const target = document.querySelector('#page-content');
  if (activeView === 'findings') {
    target.innerHTML = renderFindings();
    return;
  }
  target.innerHTML = `
    <section class="workspace">
      <aside class="recording-list" aria-label="Recordings"><h2>Recordings</h2><div id="recording-buttons"></div></aside>
      <section class="detail" aria-live="polite"><div id="detail-content"></div></section>
    </section>`;
  renderRecordingButtons();
  selectRecording(activeRecording);
}

function renderRecordingButtons() {
  const target = document.querySelector('#recording-buttons');
  target.innerHTML = report.recordings.map((recording) => `
    <button class="recording-button ${recording.recordingId === activeRecording ? 'active' : ''}" data-recording="${recording.recordingId}">
      <span>${recording.recordingId}</span><small class="pill ${recording.verdict}">${verdictLabel(recording.verdict)}</small>
    </button>`).join('');
  target.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => selectRecording(button.dataset.recording)));
}

async function selectRecording(recordingId) {
  activeRecording = recordingId;
  renderRecordingButtons();
  const target = document.querySelector('#detail-content');
  target.innerHTML = '<p class="loading">Loading waveform…</p>';
  try {
    const [recording, waveform] = await Promise.all([
      Promise.resolve(report.recordings.find((item) => item.recordingId === recordingId)),
      fetch(`${API}/waveform/${encodeURIComponent(recordingId)}`).then((response) => response.json())
    ]);
    if (waveform.error) throw new Error(waveform.error);
    target.innerHTML = renderDetail(recording, waveform);
    activeWaveform = waveform;
    waveformView = { start: 0, end: waveform.durationSeconds };
    requestAnimationFrame(() => initialiseWaveformChart(document.querySelector('#waveform'), waveform));
  } catch (error) {
    target.innerHTML = `<p class="error">Could not load this waveform: ${escapeHtml(error.message)}</p>`;
  }
}

function metricTotal(recording, field, metric) {
  return recording.usableSegments.reduce((total, segment) => total + (segment[field]?.[metric] ?? 0), 0);
}

function reviewWindows(recording) {
  return recording.usableSegments.reduce((total, segment) => total + segment.windows.filter((window) => window.verdict === 'review').length, 0);
}

function exclusions(recording) {
  return recording.excludedIntervals.length;
}

function streamFinding(recording) {
  const rawPeaks = metricTotal(recording, 'before', 'pulseCount');
  const filteredPeaks = metricTotal(recording, 'after', 'pulseCount');
  const rawAtlas = totalAtlasReviews(recording, 'rawBeatAtlas');
  const filteredAtlas = totalAtlasReviews(recording, 'beatAtlas');
  const reviewCount = reviewWindows(recording);
  if (recording.recordingId === 'S1') return `A flatline is excluded near the end of the record. The earlier segment retains ${filteredPeaks} filtered peaks, but the full record remains review-only because the final pulse region is not trustworthy.`;
  if (recording.recordingId === 'S2') return `No packet, flatline, or window-level quality failure was found. It retains ${filteredPeaks} peaks with ${filteredAtlas} post-filter morphology reviews, making it the strongest full-record candidate.`;
  if (recording.recordingId === 'S3') return `${reviewCount} windows have excess high-frequency energy. Peak candidates fall from ${rawPeaks} to ${filteredPeaks}, and DTW morphology reviews fall from ${rawAtlas} to ${filteredAtlas}.`;
  if (recording.recordingId === 'S4') return `${reviewCount} windows have periodic high-frequency interference. Peak candidates fall from ${rawPeaks} to ${filteredPeaks}, and DTW morphology reviews fall from ${rawAtlas} to ${filteredAtlas}; this is the clearest filter demonstration.`;
  return `Packet discontinuity and a missing one-second interval prevent a valid whole-record conclusion. ${filteredPeaks} peaks are only reported within separate retained segments, never across the gap.`;
}

function medianTimingShift(recording) {
  const shifts = recording.usableSegments.map((segment) => segment.comparison.medianTimingShiftMilliseconds).filter((value) => value !== null);
  return shifts.length ? `${(shifts.reduce((sum, value) => sum + value, 0) / shifts.length).toFixed(1)} ms` : '—';
}

function renderFindings() {
  const rows = report.recordings.map((recording) => {
    const rawPeaks = metricTotal(recording, 'before', 'pulseCount');
    const filteredPeaks = metricTotal(recording, 'after', 'pulseCount');
    const rawAtlas = totalAtlasReviews(recording, 'rawBeatAtlas');
    const filteredAtlas = totalAtlasReviews(recording, 'beatAtlas');
    return `<tr>
      <td><strong>${recording.recordingId}</strong></td>
      <td><span class="pill ${recording.verdict}">${verdictLabel(recording.verdict)}</span></td>
      <td>${recording.issues.length || 'none'}</td>
      <td>${exclusions(recording)}</td>
      <td>${reviewWindows(recording)}</td>
      <td>${rawPeaks} → ${filteredPeaks}</td>
      <td>${rawAtlas} → ${filteredAtlas}</td>
      <td>${medianTimingShift(recording)}</td>
    </tr>`;
  }).join('');
  const cards = report.recordings.map((recording) => `
    <article class="finding-card ${recording.verdict}">
      <div class="finding-heading"><h3>${recording.recordingId}</h3><span class="pill ${recording.verdict}">${verdictLabel(recording.verdict)}</span></div>
      <p>${streamFinding(recording)}</p>
    </article>`).join('');
  return `
    <section class="findings-page">
      <div class="section-intro"><p class="eyebrow">Evidence, not appearance</p><h2>Findings for every stream</h2><p>Each conclusion combines packet integrity, excluded intervals, spectral quality windows, peak behavior, and beat-atlas morphology checks.</p></div>
      <section class="finding-grid">${cards}</section>
      <section class="comparison-panel">
        <div class="panel-heading"><div><p class="eyebrow">Like-for-like assessment</p><h2>Raw versus filtered comparison</h2></div><p>Arrows show the same recording before and after processing. A lower false-candidate count is useful only when packet integrity remains intact and timing stays stable.</p></div>
        <div class="table-wrap"><table><thead><tr><th>Stream</th><th>Verdict</th><th>Integrity issues</th><th>Excluded intervals</th><th>Review windows</th><th>Peak candidates</th><th>DTW reviews</th><th>Peak shift</th></tr></thead><tbody>${rows}</tbody></table></div>
      </section>
      <section class="conclusion-grid">
        <article class="conclusion best-record"><p class="eyebrow">Best complete recording</p><h2>S2</h2><p>S2 is the only accepted stream: it has no packet-integrity issue, no excluded interval, no flagged quality window, 36 filtered peaks, and no remaining DTW morphology review. It is the best source for a full-record timing measurement.</p></article>
        <article class="conclusion best-method"><p class="eyebrow">Best mitigation demonstration</p><h2>S4 + zero-phase filtering</h2><p>S4 gives the clearest evidence that the mitigation changes an artifact problem: 41 raw peak candidates become 36 filtered candidates, four raw morphology outliers become zero, and matched peak timing shifts by only about 15 ms. This supports a timing-focused conclusion—not an amplitude or morphology-preservation claim.</p></article>
        <article class="conclusion boundary"><p class="eyebrow">Do not over-claim</p><h2>S5 remains rejected</h2><p>Filtering and DTW cannot recreate missing packets. The one-second gap means that valid surrounding segments may be described separately, but there is no valid whole-record result.</p></article>
      </section>
    </section>`;
}

function renderDetail(recording, waveform) {
  const issues = recording.issues.length ? recording.issues.map((issue) => issue.type.replaceAll('_', ' ')).join(', ') : 'No packet-integrity issues.';
  const excluded = recording.excludedIntervals.length
    ? recording.excludedIntervals.map((interval) => `${interval.startSeconds}–${interval.endSeconds}s: ${interval.reasons.join(', ')}`).join('<br>')
    : 'None';
  const rawAtlas = totalAtlasReviews(recording, 'rawBeatAtlas');
  const filteredAtlas = totalAtlasReviews(recording, 'beatAtlas');
  const filteredPeaks = recording.usableSegments.reduce((total, segment) => total + segment.after.pulseCount, 0);
  const medianBpm = recording.usableSegments.map((segment) => segment.after.medianBpm).filter(Boolean).join(', ') || '—';
  return `
    <div class="detail-header">
      <div><p class="eyebrow">Selected stream</p><h2>${recording.recordingId}</h2></div>
      <span class="pill large ${recording.verdict}">${verdictLabel(recording.verdict)}</span>
    </div>
    <div class="metric-grid">
      ${statusCard('Filtered peaks', filteredPeaks)}
      ${statusCard('Median BPM', medianBpm)}
      ${statusCard('Raw DTW reviews', rawAtlas, rawAtlas ? 'review' : '')}
      ${statusCard('Filtered DTW reviews', filteredAtlas, filteredAtlas ? 'review' : 'accepted')}
    </div>
    <section class="chart-section">
      <div class="chart-copy"><div><h3>Raw versus filtered waveform</h3><p>Orange bands require review; purple bands are excluded. Red markers are raw beat-atlas morphology outliers.</p></div><div class="legend"><span class="raw-key">Raw</span><span class="filtered-key">Filtered</span><span class="review-key">Review</span><span class="excluded-key">Excluded</span></div></div>
      <div class="chart-toolbar"><span id="view-domain">Viewing full recording</span><span class="chart-help">Hover to inspect · drag to zoom · scroll to zoom · double-click to reset</span><button id="reset-view" type="button">Reset view</button></div>
      <div class="interactive-chart"><svg id="waveform" tabindex="0" role="img" aria-label="${recording.recordingId} interactive raw and filtered PPG waveform"></svg><div id="chart-tooltip" class="chart-tooltip" hidden></div></div>
    </section>
    <section class="evidence-grid">
      <article><h3>Packet integrity</h3><p>${escapeHtml(issues)}</p></article>
      <article><h3>Excluded intervals</h3><p>${excluded}</p></article>
      <article><h3>Interpretation boundary</h3><p>The dashboard indicates data quality and processing effects only. It does not establish physiology or clinical validity.</p></article>
    </section>`;
}

function flatPoints(series) {
  return series.flat();
}

function nearestPoint(series, time) {
  let nearest = null;
  let distance = Infinity;
  for (const point of flatPoints(series)) {
    const candidateDistance = Math.abs(point[0] - time);
    if (candidateDistance < distance) {
      nearest = point;
      distance = candidateDistance;
    }
  }
  return nearest;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(value, upper));
}

function setViewDomain(waveform) {
  const label = document.querySelector('#view-domain');
  if (!label || !waveformView) return;
  const full = waveformView.start === 0 && waveformView.end === waveform.durationSeconds;
  label.textContent = full ? 'Viewing full recording' : `${waveformView.start.toFixed(2)}–${waveformView.end.toFixed(2)} s`;
}

function drawWaveform(svg, waveform) {
  const width = Math.max(svg.clientWidth, 340);
  const height = 430;
  const margin = { top: 24, right: 20, bottom: 48, left: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = [...flatPoints(waveform.rawSegments), ...flatPoints(waveform.filteredSegments)];
  const visiblePoints = points.filter((point) => point[0] >= waveformView.start && point[0] <= waveformView.end);
  const values = (visiblePoints.length ? visiblePoints : points).map((point) => point[1]);
  const lower = Math.min(...values); const upper = Math.max(...values); const padding = Math.max((upper - lower) * 0.08, 0.05);
  const yMin = lower - padding; const yMax = upper + padding;
  const x = (time) => margin.left + ((time - waveformView.start) / (waveformView.end - waveformView.start)) * plotWidth;
  const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
  const path = (series) => series.map((point, index) => `${index ? 'L' : 'M'}${x(point[0]).toFixed(2)},${y(point[1]).toFixed(2)}`).join(' ');
  const tickLines = Array.from({ length: 7 }, (_, index) => {
    const time = waveformView.start + ((waveformView.end - waveformView.start) * index / 6);
    const px = x(time);
    return `<line x1="${px}" x2="${px}" y1="${margin.top}" y2="${margin.top + plotHeight}" class="grid"/><text x="${px}" y="${height - 20}" text-anchor="middle">${time.toFixed(0)}</text>`;
  }).join('');
  const yLines = Array.from({ length: 5 }, (_, index) => {
    const value = yMin + ((yMax - yMin) * index / 4); const py = y(value);
    return `<line x1="${margin.left}" x2="${margin.left + plotWidth}" y1="${py}" y2="${py}" class="grid"/><text x="${margin.left - 8}" y="${py + 4}" text-anchor="end">${value.toFixed(1)}</text>`;
  }).join('');
  const band = (start, end, className) => {
    const left = Math.max(start, waveformView.start);
    const right = Math.min(end, waveformView.end);
    return right > left ? `<rect class="${className}" x="${x(left)}" y="${margin.top}" width="${x(right) - x(left)}" height="${plotHeight}"/>` : '';
  };
  const reviewBands = waveform.reviewWindows.map((window) => band(window.startSample / waveform.samplingRateHz, window.endSample / waveform.samplingRateHz, 'review-band')).join('');
  const excludedBands = waveform.excludedIntervals.map((interval) => band(interval.startSeconds, interval.endSeconds, 'excluded-band')).join('');
  const rawPaths = waveform.rawSegments.map((series) => `<path class="raw-line" d="${path(series)}"/>`).join('');
  const filteredPaths = waveform.filteredSegments.map((series) => `<path class="filtered-line" d="${path(series)}"/>`).join('');
  const atlasMarkers = waveform.rawAtlasReviewBeats.filter((beat) => beat.timeSeconds >= waveformView.start && beat.timeSeconds <= waveformView.end).map((beat) => `<line class="atlas-marker" x1="${x(beat.timeSeconds)}" x2="${x(beat.timeSeconds)}" y1="${margin.top}" y2="${margin.top + plotHeight}"/><circle class="atlas-dot" cx="${x(beat.timeSeconds)}" cy="${margin.top + 11}" r="4"><title>DTW review: ${beat.dtwDistance}</title></circle>`).join('');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `<defs><clipPath id="plot-clip"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs><rect class="frame" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"/>${tickLines}${yLines}<g clip-path="url(#plot-clip)">${reviewBands}${excludedBands}${rawPaths}${filteredPaths}${atlasMarkers}</g><line class="hover-line" x1="0" x2="0" y1="${margin.top}" y2="${margin.top + plotHeight}" hidden/><circle class="hover-dot raw-hover-dot" r="3.5" hidden/><circle class="hover-dot filtered-hover-dot" r="3.5" hidden/><text class="axis-title" x="${margin.left + plotWidth / 2}" y="${height - 4}" text-anchor="middle">Time (s)</text><text class="axis-title" x="16" y="${margin.top + plotHeight / 2}" transform="rotate(-90 16 ${margin.top + plotHeight / 2})" text-anchor="middle">Amplitude (a.u.)</text>`;
  svg.__chartGeometry = { margin, plotWidth, plotHeight, x, y };
  setViewDomain(waveform);
}

function inspectWaveform(svg, waveform, event) {
  const geometry = svg.__chartGeometry;
  if (!geometry) return;
  const rect = svg.getBoundingClientRect();
  const relativeX = (event.clientX - rect.left) * (svg.clientWidth / rect.width);
  const { margin, plotWidth, x, y } = geometry;
  if (relativeX < margin.left || relativeX > margin.left + plotWidth) return hideInspection(svg);
  const time = waveformView.start + ((relativeX - margin.left) / plotWidth) * (waveformView.end - waveformView.start);
  const raw = nearestPoint(waveform.rawSegments, time);
  const filtered = nearestPoint(waveform.filteredSegments, time);
  const guide = svg.querySelector('.hover-line');
  guide.setAttribute('x1', x(time)); guide.setAttribute('x2', x(time)); guide.hidden = false;
  for (const [selector, point] of [['.raw-hover-dot', raw], ['.filtered-hover-dot', filtered]]) {
    const dot = svg.querySelector(selector);
    dot.setAttribute('cx', x(time)); dot.setAttribute('cy', y(point[1])); dot.hidden = false;
  }
  const tooltip = document.querySelector('#chart-tooltip');
  tooltip.innerHTML = `<strong>${time.toFixed(3)} s</strong><span>Raw: ${raw[1].toFixed(4)} a.u.</span><span>Filtered: ${filtered[1].toFixed(4)} a.u.</span>`;
  tooltip.hidden = false;
  tooltip.style.left = `${clamp(event.clientX - rect.left + 14, 8, rect.width - 155)}px`;
  tooltip.style.top = `${clamp(event.clientY - rect.top + 14, 8, rect.height - 82)}px`;
}

function hideInspection(svg) {
  svg.querySelector('.hover-line')?.setAttribute('hidden', '');
  svg.querySelectorAll('.hover-dot').forEach((dot) => dot.setAttribute('hidden', ''));
  const tooltip = document.querySelector('#chart-tooltip');
  if (tooltip) tooltip.hidden = true;
}

function timeAtPointer(svg, event) {
  const geometry = svg.__chartGeometry;
  const rect = svg.getBoundingClientRect();
  const relativeX = (event.clientX - rect.left) * (svg.clientWidth / rect.width);
  return clamp(waveformView.start + ((relativeX - geometry.margin.left) / geometry.plotWidth) * (waveformView.end - waveformView.start), waveformView.start, waveformView.end);
}

function initialiseWaveformChart(svg, waveform) {
  drawWaveform(svg, waveform);
  document.querySelector('#reset-view').addEventListener('click', () => {
    waveformView = { start: 0, end: waveform.durationSeconds };
    drawWaveform(svg, waveform);
  });
  svg.addEventListener('pointermove', (event) => {
    if (dragState) return;
    inspectWaveform(svg, waveform, event);
  });
  svg.addEventListener('pointerleave', () => hideInspection(svg));
  svg.addEventListener('pointerdown', (event) => {
    dragState = { startTime: timeAtPointer(svg, event), startX: event.clientX };
    svg.setPointerCapture(event.pointerId);
    hideInspection(svg);
  });
  svg.addEventListener('pointerup', (event) => {
    if (!dragState) return;
    const endTime = timeAtPointer(svg, event);
    if (Math.abs(event.clientX - dragState.startX) > 8 && Math.abs(endTime - dragState.startTime) >= 0.08) {
      waveformView = { start: Math.min(dragState.startTime, endTime), end: Math.max(dragState.startTime, endTime) };
      drawWaveform(svg, waveform);
    }
    dragState = undefined;
    svg.releasePointerCapture(event.pointerId);
  });
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const centre = timeAtPointer(svg, event);
    const currentRange = waveformView.end - waveformView.start;
    const nextRange = clamp(currentRange * (event.deltaY > 0 ? 1.25 : 0.8), 0.08, waveform.durationSeconds);
    const fraction = (centre - waveformView.start) / currentRange;
    const start = clamp(centre - nextRange * fraction, 0, waveform.durationSeconds - nextRange);
    waveformView = { start, end: start + nextRange };
    drawWaveform(svg, waveform);
  }, { passive: false });
  svg.addEventListener('dblclick', () => {
    waveformView = { start: 0, end: waveform.durationSeconds };
    drawWaveform(svg, waveform);
  });
}

async function start() {
  try {
    const response = await fetch(`${API}/report`);
    report = await response.json();
    if (!response.ok) throw new Error(report.error ?? 'The API did not return a report.');
    activeRecording = report.recordings[0].recordingId;
    renderShell();
  } catch (error) {
    app.innerHTML = `<main class="error-page"><h1>PPG PulseCheck could not start</h1><p>${escapeHtml(error.message)}</p><p>Run <code>npm run dev</code> from the project directory and keep both API and web processes running.</p></main>`;
  }
}

addEventListener('resize', () => {
  const svg = document.querySelector('#waveform');
  if (!svg || !activeWaveform) return;
  drawWaveform(svg, activeWaveform);
});

start();
