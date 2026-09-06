import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const generatedSegments = new Set([
  '.dart_tool', '.example-dist', '.git', '.next', '.test-dist', 'artifacts',
  'build', 'coverage', 'dist', 'local-artifacts', 'node_modules', 'out', 'release', 'tmp',
]);
const sourcePathPrefixes = [
  'apps/agent_bridge/release/',
  'scripts/release/',
];
const allowedGeneratedPaths = new Set();
const maximumTrackedFileBytes = 100 * 1024 * 1024;
const credentialExtensions = new Set([
  '.jks', '.key', '.keystore', '.mobileprovision', '.p12', '.pem', '.pfx',
]);
const sourceCodeExtensions = new Set([
  '.cjs', '.cts', '.dart', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx',
]);
const textExtensions = new Set([
  '', '.bat', '.c', '.cjs', '.cmd', '.cmake', '.cpp', '.css', '.cts', '.dart', '.env', '.h', '.html', '.in', '.js', '.json',
  '.jsx', '.kt', '.kts', '.lock', '.md', '.mjs', '.mts', '.properties', '.ps1', '.py', '.sh', '.sql',
  '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml', '.gradle',
]);
const allowedCredentialNames = new Set([
  '.env.example',
  'packages/protocol/test_vectors/credential_vectors.json',
]);
const desktopConfigPrivateKeyFixture = [
  '"-----BEGIN PRIVATE',
  ' KEY-----\\ntest\\n-----END PRIVATE KEY-----"',
].join('');
const allowedSecretFixtureLiterals = new Map([
  [
    'apps/desktop_harness/test/desktop_config.test.mjs',
    [desktopConfigPrivateKeyFixture],
  ],
]);
const placeholderUsers = new Set(['deploy', 'example', 'example user', 'person', 'public', 'test', 'user', 'username', 'you']);
const secretPatterns = [
  { reason: 'private key material', pattern: /-----BEGIN (?:DSA |EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/u },
  { reason: 'AWS access key identifier', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { reason: 'GitHub access token', pattern: /\b(?:github_pat_[A-Za-z0-9_]{70,255}|gh[pousr]_[A-Za-z0-9]{36,255})\b/u },
  { reason: 'OpenAI API key', pattern: /\bsk-(?:admin|proj|svcacct)-[A-Za-z0-9_-]{20,}\b/u },
  { reason: 'Anthropic API key', pattern: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}\b/u },
  { reason: 'OpenRouter API key', pattern: /\bsk-or-v1-[0-9A-Fa-f]{32,}\b/u },
  { reason: 'API key with sk- prefix', pattern: /\bsk-[A-Za-z0-9]{40,}\b/u },
  { reason: 'Groq API key', pattern: /\bgsk_[A-Za-z0-9]{20,}\b/u },
  { reason: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { reason: 'Google OAuth client secret', pattern: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/u },
  { reason: 'xAI API key', pattern: /\bxai-[0-9A-Za-z_-]{20,}\b/u },
  { reason: 'Cerebras API key', pattern: /\bcsk-[0-9A-Za-z_-]{20,}\b/u },
  { reason: 'Fireworks API key', pattern: /\bfw_[0-9A-Za-z]{20,}\b/u },
  { reason: 'Perplexity API key', pattern: /\bpplx-[0-9A-Za-z]{20,}\b/u },
  { reason: 'Hugging Face access token', pattern: /\bhf_[0-9A-Za-z]{30,}\b/u },
  { reason: 'npm access token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/u },
  { reason: 'Slack access token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u },
  { reason: 'Stripe live secret key', pattern: /\bsk_live_[0-9A-Za-z]{20,}\b/u },
];

function publicationFiles() {
  const result = spawnSync('git', ['-C', repositoryRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: null,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return undefined;
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

const forbiddenProductTierPhrases = [
  ['paid', 'version'], ['free', 'version'], ['premium', 'version'],
  ['paid', 'edition'], ['free', 'edition'], ['premium', 'edition'],
  ['paid', 'tier'], ['free', 'tier'], ['premium', 'tier'],
  ['free', 'or', 'paid'], ['internal', 'only'], ['private', 'edition'],
].map((parts) => parts.join(' '));

function publicReleaseContentReason(text) {
  const normalized = text.toLowerCase().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ');
  const phrase = forbiddenProductTierPhrases.find((candidate) => normalized.includes(candidate));
  return phrase === undefined ? undefined : `internal product-tier language (${phrase})`;
}

function packageLicenseReason(path, text) {
  if (basename(path) !== 'package.json') return undefined;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return 'invalid package.json';
  }
  return manifest.license === 'MIT' ? undefined : 'first-party package license must be MIT';
}

function generatedPathReason(path) {
  if (path.split('/').some((segment) => segment.toLowerCase() === 'local-artifacts')
    || /^TETHOQ_UI_(?:FEEDBACK_LEDGER|DOCTRINE).*\.(?:json|md)$/iu.test(basename(path))) return 'private local notes';
  if (allowedGeneratedPaths.has(path) || sourcePathPrefixes.some((prefix) => path.startsWith(prefix))) return undefined;
  const segment = path.split('/').find((candidate) => {
    const normalized = candidate.toLowerCase();
    return generatedSegments.has(normalized) || normalized.startsWith('qa-artifacts');
  });
  return segment === undefined ? undefined : `tracked generated/build path (${segment})`;
}

function credentialFilenameReason(path) {
  const normalized = path.replaceAll('\\', '/');
  if (allowedCredentialNames.has(normalized)) return undefined;
  const name = basename(normalized).toLowerCase();
  const extension = extname(name);
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return 'environment file';
  if (credentialExtensions.has(extension)) return `credential extension ${extension}`;
  if (name === 'key.properties' || name === 'credentials.json' || name === 'service-account.json') return 'credential filename';
  if (sourceCodeExtensions.has(extension)) return undefined;
  if (/(?:^|[-_.])(credentials?|private[-_.]?key|secrets?)(?:[-_.]|$)/iu.test(name)) return 'credential-like filename';
  return undefined;
}

function personalPathReason(text) {
  const windowsPatterns = [
    /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\r\n"'`]+)[\\/]/giu,
  ];
  for (const pattern of windowsPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!placeholderUsers.has(match[1].trim().toLowerCase())) return 'hard-coded Windows user path';
    }
  }
  for (const pattern of [/\/Users\/([^/\r\n]+)\//gu, /\/home\/([^/\r\n]+)\//gu]) {
    for (const match of text.matchAll(pattern)) {
      if (!placeholderUsers.has(match[1].trim().toLowerCase())) return 'hard-coded POSIX user path';
    }
  }
  return undefined;
}

function secretContentReason(path, text) {
  let scannableText = text;
  for (const fixture of allowedSecretFixtureLiterals.get(path) ?? []) {
    scannableText = scannableText.replaceAll(fixture, 'KNOWN_TEST_SECRET_FIXTURE');
  }
  for (const { reason, pattern } of secretPatterns) {
    if (pattern.test(scannableText)) return reason;
  }
  const literalCredential = /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)\b\s*[:=]\s*["']([^"'\r\n]{32,})["']/giu;
  for (const match of scannableText.matchAll(literalCredential)) {
    const value = match[1].trim();
    const isPlaceholder = /^(?:example|fake|placeholder|sample|test)(?:[-_ ][0-9A-Za-z]+)*$/iu.test(value)
      || /^replace-with(?:[-_ ][0-9A-Za-z]+)+$/iu.test(value)
      || /^your(?:[-_ ][0-9A-Za-z]+)+$/iu.test(value)
      || /^[x0]{8,}$/iu.test(value)
      || /^\$\{[0-9A-Z_]+\}$/u.test(value)
      || /^<[^>\r\n]+>$/u.test(value);
    if (!isPlaceholder) {
      return 'hard-coded credential literal';
    }
  }
  return undefined;
}

const files = publicationFiles();
if (files === undefined) {
  if (process.env.CI === 'true') {
    console.error('Publication boundary gate requires Git metadata in CI.');
    process.exitCode = 1;
  } else {
    console.log('Publication boundary gate skipped: this source tree has no Git metadata.');
  }
} else {
  const failures = [];
  for (const trackedPath of files) {
    const normalized = trackedPath.replaceAll('\\', '/');
    const absolute = resolve(repositoryRoot, ...normalized.split('/'));
    const metadata = await stat(absolute).catch(() => undefined);
    if (!metadata?.isFile()) continue;
    const generatedReason = generatedPathReason(normalized);
    if (generatedReason !== undefined) {
      failures.push({ path: normalized, reason: generatedReason });
      continue;
    }
    if (metadata.size > maximumTrackedFileBytes) {
      failures.push({ path: normalized, reason: 'tracked file exceeds 100 MB' });
      continue;
    }
    const filenameReason = credentialFilenameReason(normalized);
    if (filenameReason !== undefined) failures.push({ path: normalized, reason: filenameReason });
    if (!textExtensions.has(extname(normalized).toLowerCase())) continue;
    if (metadata.size > 2 * 1024 * 1024) continue;
    const text = await readFile(absolute, 'utf8');
    const packageReason = packageLicenseReason(normalized, text);
    if (packageReason !== undefined) failures.push({ path: normalized, reason: packageReason });
    const releaseContentReason = publicReleaseContentReason(text);
    if (releaseContentReason !== undefined) failures.push({ path: normalized, reason: releaseContentReason });
    const personalReason = personalPathReason(text);
    if (personalReason !== undefined) failures.push({ path: relative(repositoryRoot, absolute).split(sep).join('/'), reason: personalReason });
    const secretReason = secretContentReason(normalized, text);
    if (secretReason !== undefined) failures.push({ path: normalized, reason: secretReason });
  }
  if (failures.length > 0) {
    console.error('Publication boundary gate failed. Matched contents are intentionally not printed.');
    for (const failure of failures) console.error(`- ${failure.path}: ${failure.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`Publication boundary gate passed across ${files.length} public files.`);
  }
}
