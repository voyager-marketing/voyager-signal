#!/usr/bin/env node
// package.js — build a .zip of the extension directory for Chrome Web Store upload

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');

// Read version from manifest
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipName = `voyager-signal-v${version}.zip`;

// Ensure output directory
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const zipPath = path.join(OUT_DIR, zipName);

// Remove old zip if it exists
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Run validation first
console.log('Running validation...\n');
try {
  execSync('node ' + path.join(__dirname, 'validate.js'), { stdio: 'inherit' });
} catch {
  console.error('\nValidation failed. Fix errors before packaging.');
  process.exit(1);
}

// Check that icon PNGs exist (Chrome requires them)
console.log('\n--- Icons ---');
const requiredIcons = ['icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png'];
let iconsOk = true;
for (const icon of requiredIcons) {
  const iconPath = path.join(EXT_DIR, icon);
  if (fs.existsSync(iconPath)) {
    const size = fs.statSync(iconPath).size;
    if (size === 0) {
      console.error(`  FAIL: ${icon} is empty (0 bytes)`);
      iconsOk = false;
    } else {
      console.log(`  OK: ${icon} (${size} bytes)`);
    }
  } else {
    console.error(`  FAIL: ${icon} not found`);
    iconsOk = false;
  }
}

if (!iconsOk) {
  console.error('\nIcon files missing or empty. Cannot package.');
  process.exit(1);
}

// Create zip — exclude .gitkeep, SVGs, and hidden files
console.log(`\nPackaging extension v${version}...`);

try {
  execSync(
    `cd "${EXT_DIR}" && zip -r "${zipPath}" . -x "*.gitkeep" "*.svg" ".*"`,
    { stdio: 'pipe' }
  );
} catch (err) {
  // zip might not be available — fall back to tar
  console.log('zip not available, trying tar...');
  const tarPath = zipPath.replace('.zip', '.tar.gz');
  execSync(
    `cd "${EXT_DIR}" && tar --exclude='*.gitkeep' --exclude='*.svg' --exclude='.*' -czf "${tarPath}" .`,
    { stdio: 'pipe' }
  );
  console.log(`\nPackaged: ${tarPath}`);
  const tarSize = fs.statSync(tarPath).size;
  console.log(`Size: ${(tarSize / 1024).toFixed(1)} KB`);
  process.exit(0);
}

const zipSize = fs.statSync(zipPath).size;
console.log(`\nPackaged: ${zipPath}`);
console.log(`Size: ${(zipSize / 1024).toFixed(1)} KB`);
console.log('Ready for Chrome Web Store upload.');
