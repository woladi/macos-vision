import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const TARGETS = [
  { arch: 'arm64', swift: 'arm64-apple-macos12' },
  { arch: 'x64', swift: 'x86_64-apple-macos12' },
];
const HELPERS = ['vision-helper', 'pdf-helper'];

for (const { arch, swift } of TARGETS) {
  const outDir = path.join(root, 'bin', `darwin-${arch}`);
  mkdirSync(outDir, { recursive: true });

  for (const name of HELPERS) {
    const src = path.join(root, 'src', 'native', `${name}.swift`);
    const out = path.join(outDir, name);
    execSync(`swiftc -O -target ${swift} "${src}" -o "${out}"`, { stdio: 'inherit' });
  }

  const tarball = `bin-darwin-${arch}.tar.gz`;
  execSync(`tar -czf "${tarball}" -C "${outDir}" ${HELPERS.join(' ')}`, {
    stdio: 'inherit',
    cwd: root,
  });

  const tarPath = path.join(root, tarball);
  const sha = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
  writeFileSync(path.join(root, `${tarball}.sha256`), `${sha}\n`);

  console.log(`✅ ${tarball} (sha256: ${sha.slice(0, 16)}…)`);
}
