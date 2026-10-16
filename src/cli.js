'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeDocument } = require('./pipeline');

function usage() {
  return [
    'Usage: npm run analyze -- --input <source.json> [--output <report.json>]',
    '',
    'The source file is read only. The report contains packet-integrity findings,',
    'excluded intervals, quality-gate results, and before/after pulse metrics.'
  ].join('\n');
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    if (argument === '--input' || argument === '--output') {
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.input) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output ?? 'analysis-report.json');
  const document = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const report = analyzeDocument(document);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const summary = report.recordings.map(({ recordingId, verdict, usableSegments }) => ({
    recordingId,
    verdict,
    usableSegments: usableSegments.length
  }));
  console.log(JSON.stringify({ outputPath, summary }, null, 2));
}

main();
