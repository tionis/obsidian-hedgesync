#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function printUsage() {
  console.log(
    [
      'Usage:',
      '  npm run release:version -- <version> [--remote <name>] [--branch <name>] [--dry-run] [--allow-dirty]',
      '',
      'Example:',
      '  npm run release:version -- 0.0.8',
      '  npm run release:version -- 0.0.8 --remote origin --branch main'
    ].join('\n')
  );
}

function fail(message) {
  console.error(`release-version: ${message}`);
  process.exit(1);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    throw result.error;
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? ''
  };
}

function runGit(args) {
  const result = runCommand('git', args);
  if (result.code !== 0) {
    const details = result.stderr || result.stdout || `exit code ${result.code}`;
    fail(`git ${args.join(' ')} failed: ${details}`);
  }
  return result.stdout;
}

function parseVersion(version) {
  if (!SEMVER_PATTERN.test(version)) {
    fail(`invalid version "${version}" (expected x.y.z)`);
  }
  return version.split('.').map(part => Number(part));
}

function compareVersions(a, b) {
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const left = aParts[index] ?? 0;
    const right = bParts[index] ?? 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }
  return 0;
}

function parseArgs(argv) {
  const options = {
    version: '',
    remote: 'origin',
    branch: 'main',
    dryRun: false,
    allowDirty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--remote') {
      const value = argv[index + 1];
      if (!value) {
        fail('missing value for --remote');
      }
      options.remote = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--remote=')) {
      options.remote = token.slice('--remote='.length);
      continue;
    }
    if (token === '--branch') {
      const value = argv[index + 1];
      if (!value) {
        fail('missing value for --branch');
      }
      options.branch = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--branch=')) {
      options.branch = token.slice('--branch='.length);
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    if (token === '-h' || token === '--help') {
      printUsage();
      process.exit(0);
    }
    if (token.startsWith('-')) {
      fail(`unknown option "${token}"`);
    }
    if (options.version) {
      fail(`unexpected extra argument "${token}"`);
    }
    options.version = token;
  }

  if (!options.version) {
    printUsage();
    fail('missing required version argument');
  }

  return options;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const requestedVersion = options.version.trim();

  runGit(['rev-parse', '--is-inside-work-tree']);
  const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== options.branch) {
    fail(`current branch is "${currentBranch}". Switch to "${options.branch}" or pass --branch.`);
  }

  if (!options.allowDirty) {
    const status = runGit(['status', '--porcelain']);
    if (status.length > 0) {
      fail('working tree is not clean. Commit or stash changes first, or pass --allow-dirty.');
    }
  }

  const packagePath = 'package.json';
  const manifestPath = 'manifest.json';
  const versionsPath = 'versions.json';
  const pkg = readJson(packagePath);
  const manifest = readJson(manifestPath);
  const versionsRaw = readJson(versionsPath);
  const versions = versionsRaw && typeof versionsRaw === 'object' ? versionsRaw : {};

  const currentVersion = String(manifest.version ?? '').trim();
  if (!SEMVER_PATTERN.test(currentVersion)) {
    fail(`manifest version "${currentVersion}" is not valid x.y.z`);
  }
  if (compareVersions(requestedVersion, currentVersion) <= 0) {
    fail(`requested version "${requestedVersion}" must be larger than current "${currentVersion}"`);
  }

  const tagCheck = runCommand('git', ['rev-parse', '-q', '--verify', `refs/tags/${requestedVersion}`]);
  if (tagCheck.code === 0) {
    fail(`tag "${requestedVersion}" already exists.`);
  }
  if (tagCheck.code !== 1) {
    const details = tagCheck.stderr || tagCheck.stdout || `exit code ${tagCheck.code}`;
    fail(`unable to verify existing tag: ${details}`);
  }

  const minAppVersion = String(manifest.minAppVersion ?? '').trim();
  if (!minAppVersion) {
    fail('manifest minAppVersion is missing');
  }

  pkg.version = requestedVersion;
  manifest.version = requestedVersion;
  versions[requestedVersion] = minAppVersion;
  const orderedVersions = Object.fromEntries(
    Object.entries(versions).sort(([left], [right]) => compareVersions(left, right))
  );

  if (options.dryRun) {
    console.log(`[dry-run] Would update ${packagePath}: ${currentVersion} -> ${requestedVersion}`);
    console.log(`[dry-run] Would update ${manifestPath}: ${currentVersion} -> ${requestedVersion}`);
    console.log(`[dry-run] Would update ${versionsPath}: ${requestedVersion} -> ${minAppVersion}`);
    console.log('[dry-run] Would run git add/commit/tag/push');
    return;
  }

  writeJson(packagePath, pkg);
  writeJson(manifestPath, manifest);
  writeJson(versionsPath, orderedVersions);

  console.log(`Updated ${packagePath}: ${currentVersion} -> ${requestedVersion}`);
  console.log(`Updated ${manifestPath}: ${currentVersion} -> ${requestedVersion}`);
  console.log(`Updated ${versionsPath}: ${requestedVersion} -> ${minAppVersion}`);

  runGit(['add', packagePath, manifestPath, versionsPath]);
  runGit(['commit', '-m', `release ${requestedVersion}`]);
  runGit(['tag', requestedVersion]);
  runGit(['push', options.remote, options.branch, requestedVersion]);

  console.log(`Release complete: ${requestedVersion}`);
  console.log(`Pushed branch "${options.branch}" and tag "${requestedVersion}" to "${options.remote}"`);
}

main();
