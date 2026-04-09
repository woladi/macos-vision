import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const binDir = path.join(root, 'bin');

const binaries = [
  {
    src: path.join(root, 'src', 'native', 'vision-helper.swift'),
    out: path.join(binDir, 'vision-helper'),
    name: 'vision-helper',
  },
  {
    src: path.join(root, 'src', 'native', 'pdf-helper.swift'),
    out: path.join(binDir, 'pdf-helper'),
    name: 'pdf-helper',
  },
];

const allExist = binaries.every(({ out }) => existsSync(out));
if (allExist) {
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

for (const { src, out, name } of binaries) {
  if (existsSync(out)) continue;
  try {
    execSync(`swiftc -O "${src}" -o "${out}"`, { stdio: 'inherit' });
    console.log(`✅ macos-vision: ${name} compiled successfully`);
  } catch {
    console.error(`❌ macos-vision: ${name} compilation failed.`);
    console.error('   Make sure Xcode Command Line Tools are installed:');
    console.error('   xcode-select --install');
    process.exit(1);
  }
}
