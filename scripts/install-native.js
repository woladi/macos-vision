import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  unlinkSync,
  createWriteStream,
} from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const binDir = path.join(root, 'bin');
const HELPERS = ['vision-helper', 'pdf-helper'];

// 0. Skip if all binaries already exist (cached install)
if (HELPERS.every((h) => existsSync(path.join(binDir, h)))) {
  process.exit(0);
}

// 1. Explicit opt-out — go straight to local compile
if (process.env.MACOS_VISION_SKIP_DOWNLOAD === '1') {
  console.log('macos-vision: download skipped (MACOS_VISION_SKIP_DOWNLOAD=1), compiling locally');
  fallbackToSwiftc();
  process.exit(0);
}

// 2. Non-darwin guard (package has "os": ["darwin"] but npm still runs postinstall in some setups)
if (process.platform !== 'darwin') {
  console.log(`macos-vision: platform ${process.platform} not supported, skipping native install`);
  process.exit(0);
}

const arch =
  process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;

if (!arch) {
  console.warn(`macos-vision: unsupported arch ${process.arch}, trying local compile`);
  fallbackToSwiftc();
  process.exit(0);
}

const VERSION = pkg.version;
const REPO = 'woladi/macos-vision';
const tarball = `bin-darwin-${arch}.tar.gz`;
const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${tarball}`;
const shaUrl = `${url}.sha256`;

try {
  mkdirSync(binDir, { recursive: true });
  const tmp = path.join(binDir, tarball);

  console.log(`macos-vision: downloading prebuilt ${tarball} for v${VERSION}…`);
  await download(url, tmp);

  const expected = (await fetchText(shaUrl)).trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(tmp)).digest('hex');
  if (expected !== actual) {
    throw new Error(`sha256 mismatch: got ${actual}, expected ${expected}`);
  }

  execSync(`tar -xzf "${tmp}" -C "${binDir}"`, { stdio: 'inherit' });
  unlinkSync(tmp);
  for (const h of HELPERS) chmodSync(path.join(binDir, h), 0o755);

  console.log(`✅ macos-vision: installed prebuilt binaries (darwin-${arch}, v${VERSION})`);
} catch (e) {
  console.warn(`⚠️  macos-vision: prebuilt download failed (${e.message}), trying local compile`);
  fallbackToSwiftc();
}

function fallbackToSwiftc() {
  try {
    execSync('command -v swiftc', { stdio: 'ignore' });
  } catch {
    console.error('❌ macos-vision: swiftc not available and prebuilt binaries could not be installed.');
    console.error('   Install Xcode Command Line Tools to enable the offline fallback:');
    console.error('   xcode-select --install');
    process.exit(1);
  }
  mkdirSync(binDir, { recursive: true });
  for (const h of HELPERS) {
    const src = path.join(root, 'src', 'native', `${h}.swift`);
    const out = path.join(binDir, h);
    try {
      execSync(`swiftc -O "${src}" -o "${out}"`, { stdio: 'inherit' });
      console.log(`✅ macos-vision: compiled ${h} locally`);
    } catch {
      console.error(`❌ macos-vision: ${h} compilation failed.`);
      process.exit(1);
    }
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('download timeout')));
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('fetch timeout')));
  });
}
