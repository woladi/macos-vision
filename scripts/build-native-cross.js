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
const HELPERS = ['vision-helper', 'pdf-helper', 'ui-helper'];

// Symbols added in newer SDKs are absent when building against an older one, so
// the helper gates them on -DSDK_nn. Detect what this machine's SDK provides.
function sdkDefines() {
  try {
    const raw = execSync('xcrun --sdk macosx --show-sdk-version', { encoding: 'utf8' }).trim();
    const major = parseInt(raw.split('.')[0], 10);
    if (!Number.isFinite(major)) return [];
    return [14, 15, 26].filter((n) => major >= n).map((n) => `-DSDK_${n}`);
  } catch {
    return [];
  }
}

const DEFINES = sdkDefines().join(' ');

// Release artifacts must carry every gated feature. Building on an older SDK
// would silently ship binaries where documentStructure/aesthetics report false
// on machines that actually support them — fail loudly instead.
const REQUIRED_DEFINES = ['-DSDK_14', '-DSDK_15', '-DSDK_26'];
const missing = REQUIRED_DEFINES.filter((d) => !DEFINES.includes(d));
if (missing.length) {
  console.error(
    `❌ macos-vision: SDK too old for a release build — missing ${missing.join(', ')}.\n` +
      `   Features gated behind those SDKs would be compiled out of the published binaries.\n` +
      `   Install a newer Xcode (or set SKIP_SDK_CHECK=1 for a local, non-release build).`
  );
  if (!process.env.SKIP_SDK_CHECK) process.exit(1);
}

for (const { arch, swift } of TARGETS) {
  const outDir = path.join(root, 'bin', `darwin-${arch}`);
  mkdirSync(outDir, { recursive: true });

  for (const name of HELPERS) {
    const src = path.join(root, 'src', 'native', `${name}.swift`);
    const out = path.join(outDir, name);
    execSync(`swiftc -O -target ${swift} ${DEFINES} "${src}" -o "${out}"`, { stdio: 'inherit' });
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
