import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const binDir = path.join(root, 'bin');
const binPath = path.join(binDir, 'vision-helper');
const swiftSrc = path.join(root, 'src', 'native', 'vision-helper.swift');

if (existsSync(binPath)) {
  process.exit(0);
}

if (!mkdirSync(binDir, { recursive: true }) === false) {
  // dir created
}

try {
  execSync(`swiftc -O "${swiftSrc}" -o "${binPath}"`, { stdio: 'inherit' });
  console.log('✅ macos-vision: native binary compiled successfully');
} catch {
  console.error('❌ macos-vision: Swift compilation failed.');
  console.error('   Make sure Xcode Command Line Tools are installed:');
  console.error('   xcode-select --install');
  process.exit(1);
}
