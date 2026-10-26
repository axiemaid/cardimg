#!/usr/bin/env node
/**
 * self-match-test.cjs — Verify every reference image passes the upload gate
 * and matches its own code.
 * 
 * For each reference image in cardid-detector/references/:
 *   1. Decode + crop + hash + match (same pipeline as upload gate)
 *   2. Check the matched code == expected code
 *   3. Check distance <= maxDistance, margin >= minMargin
 * 
 * Reports pass/fail per card and a summary.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { verifyImage, loadConfig } = require('../lib/upload-gate.js');

const REF_DIR = '/Users/axiemaid/.openclaw/cardid-detector/references';

function parseCode(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const m = base.match(/^([CS]\d{2})/i);
  return m ? m[1].toUpperCase() : null;
}

async function main() {
  const cfg = loadConfig();
  console.log(`Upload gate config: maxDistance=${cfg.maxDistance} minMargin=${cfg.minMargin} timeout=${cfg.detectorTimeoutMs}ms`);
  console.log('');

  const files = fs.readdirSync(REF_DIR)
    .filter(f => /\.(png|jpe?g|webp|bmp)$/i.test(f))
    .sort();

  // Group by expected code — take first file per code
  const byCode = {};
  for (const file of files) {
    const code = parseCode(file);
    if (!code) {
      console.log(`  SKIP ${file} — cannot parse code`);
      continue;
    }
    if (!byCode[code]) byCode[code] = file;
  }

  const codes = Object.keys(byCode).sort();
  console.log(`Testing ${codes.length} reference images:\n`);
  console.log('CODE  FILE                         VERDICT   MATCHED  DIST  MARG  REASON');
  console.log('-'.repeat(95));

  let pass = 0;
  let fail = 0;

  for (const code of codes) {
    const file = byCode[code];
    const fullPath = path.join(REF_DIR, file);
    const imageBuffer = fs.readFileSync(fullPath);

    const verdict = await verifyImage(imageBuffer, file);

    const codeMatch = verdict.code === code;
    const allPass = verdict.passed && codeMatch;

    if (allPass) pass++;
    else fail++;

    const status = allPass ? '✓ PASS' : '✗ FAIL';
    const matched = verdict.code || '-';
    const dist = verdict.distance !== null ? verdict.distance : '-';
    const marg = verdict.margin !== null ? verdict.margin : '-';

    console.log(
      `${code.padEnd(5)} ${file.padEnd(28)} ${status.padEnd(9)} ${matched.padEnd(8)} ${String(dist).padEnd(5)} ${String(marg).padEnd(5)} ${verdict.reason}`
    );
  }

  console.log('-'.repeat(95));
  console.log(`\n${pass}/${codes.length} passed, ${fail} failed`);

  if (fail > 0) {
    console.log('\n⚠ Failures detected — check verdicts above and upload-verdicts.jsonl');
    process.exit(1);
  } else {
    console.log('\n✓ All reference images self-match correctly.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
