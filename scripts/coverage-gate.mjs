#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const THRESHOLDS = {
  sourceOverallMin: {
    line: 90,
    branch: 80,
    funcs: 90,
  },
  requiredFiles: [
    { file: 'src/analytics-client.ts', line: 86, branch: 74, funcs: 75 },
    { file: 'src/helpers.ts', line: 78, branch: 75, funcs: 82 },
    { file: 'src/survey.ts', line: 95, branch: 70, funcs: 100 },
  ],
};

const run = spawnSync(
  'node',
  ['--experimental-test-coverage', '--import', 'tsx', '--test', 'tests/**/*.test.ts'],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  },
);

if (run.stdout) {
  process.stdout.write(run.stdout);
}
if (run.stderr) {
  process.stderr.write(run.stderr);
}

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const parseCoverageRows = (rawOutput) => {
  const rows = new Map();
  const lines = rawOutput.split(/\r?\n/);
  let currentGroup = '';

  for (const line of lines) {
    const normalized = line
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/^(?:#|ℹ)\s?/, '')
      .trim();

    const groupMatch = normalized.match(/^(.+?)\s+\|\s*\|\s*\|\s*\|\s*$/);
    if (groupMatch) {
      const group = groupMatch[1].trim().replace(/\\/g, '/');
      currentGroup = group && group !== 'all files' ? group : '';
      continue;
    }

    const match = normalized.match(
      /^(.+?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|/,
    );
    if (!match) {
      continue;
    }

    let file = match[1].trim().replace(/\\/g, '/');
    if (file !== 'all files' && !file.includes('/') && currentGroup) {
      file = `${currentGroup}/${file}`;
    }

    rows.set(file, {
      line: Number(match[2]),
      branch: Number(match[3]),
      funcs: Number(match[4]),
    });
  }

  return rows;
};

const coverageRows = parseCoverageRows(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
const failures = [];

const sourceRows = Array.from(coverageRows.entries())
  .filter(([file]) => file.startsWith('src/'))
  .map(([, metrics]) => metrics);

if (sourceRows.length === 0) {
  failures.push('No source coverage rows (`src/*`) were found in coverage output.');
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
if (sourceRows.length > 0) {
  const sourceOverall = {
    line: average(sourceRows.map((row) => row.line)),
    branch: average(sourceRows.map((row) => row.branch)),
    funcs: average(sourceRows.map((row) => row.funcs)),
  };

  if (sourceOverall.line < THRESHOLDS.sourceOverallMin.line) {
    failures.push(
      `source overall line coverage ${sourceOverall.line.toFixed(2)} < ${THRESHOLDS.sourceOverallMin.line}`,
    );
  }
  if (sourceOverall.branch < THRESHOLDS.sourceOverallMin.branch) {
    failures.push(
      `source overall branch coverage ${sourceOverall.branch.toFixed(2)} < ${THRESHOLDS.sourceOverallMin.branch}`,
    );
  }
  if (sourceOverall.funcs < THRESHOLDS.sourceOverallMin.funcs) {
    failures.push(
      `source overall function coverage ${sourceOverall.funcs.toFixed(2)} < ${THRESHOLDS.sourceOverallMin.funcs}`,
    );
  }
}

for (const requirement of THRESHOLDS.requiredFiles) {
  const row = coverageRows.get(requirement.file);
  if (!row) {
    failures.push(`Missing coverage row for required file: ${requirement.file}`);
    continue;
  }

  if (row.line < requirement.line) {
    failures.push(`${requirement.file} line coverage ${row.line.toFixed(2)} < ${requirement.line}`);
  }
  if (row.branch < requirement.branch) {
    failures.push(`${requirement.file} branch coverage ${row.branch.toFixed(2)} < ${requirement.branch}`);
  }
  if (row.funcs < requirement.funcs) {
    failures.push(`${requirement.file} function coverage ${row.funcs.toFixed(2)} < ${requirement.funcs}`);
  }
}

if (failures.length > 0) {
  process.stderr.write('\nCoverage gate failed for SDK:\n');
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write('\nCoverage gate passed for SDK.\n');
