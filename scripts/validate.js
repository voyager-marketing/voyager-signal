#!/usr/bin/env node
// validate.js — lint manifest, check required fields, validate JS syntax

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');

let errors = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  errors++;
}

function pass(msg) {
  console.log(`  OK: ${msg}`);
}

// 1. Check manifest.json exists and is valid JSON
console.log('\n--- Manifest ---');
if (!fs.existsSync(MANIFEST_PATH)) {
  fail('manifest.json not found');
} else {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    // Required fields
    const required = ['manifest_version', 'name', 'version', 'description', 'permissions', 'action', 'background'];
    for (const field of required) {
      if (manifest[field] === undefined) {
        fail(`Missing required field: ${field}`);
      } else {
        pass(`${field} present`);
      }
    }

    if (manifest.manifest_version !== 3) {
      fail(`manifest_version should be 3, got ${manifest.manifest_version}`);
    } else {
      pass('manifest_version is 3');
    }
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
  }
}

// 2. Check key files exist
console.log('\n--- Files ---');
const requiredFiles = [
  'src/background.js',
  'src/content.js',
  'src/readability.js',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup.css'
];

for (const file of requiredFiles) {
  const fullPath = path.join(EXT_DIR, file);
  if (fs.existsSync(fullPath)) {
    pass(file);
  } else {
    fail(`Missing: ${file}`);
  }
}

// 3. Validate JS syntax
console.log('\n--- JS Syntax ---');
const jsFiles = [
  'src/background.js',
  'src/content.js',
  'popup/popup.js'
];

for (const file of jsFiles) {
  const fullPath = path.join(EXT_DIR, file);
  if (!fs.existsSync(fullPath)) continue;
  try {
    execSync(`node --check "${fullPath}"`, { stdio: 'pipe' });
    pass(`${file} syntax OK`);
  } catch (e) {
    fail(`${file} syntax error: ${e.stderr?.toString().trim()}`);
  }
}

// Summary
console.log('\n---');
if (errors === 0) {
  console.log('All checks passed.\n');
  process.exit(0);
} else {
  console.log(`${errors} error(s) found.\n`);
  process.exit(1);
}
