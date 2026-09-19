/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../..');
const BASE_KEY = 'microvm-images/agent-artifact.zip';
const BUILD_INPUTS = [
  'agent/pyproject.toml', 'agent/uv.lock', 'agent/src/runner.py',
  'agent/policies/test.cedar', 'agent/workflows/test.yaml',
  'agent/prepare-commit-msg.sh', 'agent/managed-settings.json', 'contracts/constants.json',
];

// An executable fake CLI exercises the real shell/Python packagers without
// network access. It validates PUT checksums and enforces If-None-Match against
// a local object store; unexpected AWS operations fail instead of falling back.
const AWS = `#!/usr/bin/env python3
import base64, hashlib, json, os, pathlib, sys
args = sys.argv[1:]
store = pathlib.Path(os.environ["MICROVM_TEST_STORE"])
with (store / "calls.jsonl").open("a") as f:
    f.write(json.dumps(args) + "\\n")
def arg(name):
    return args[args.index(name) + 1]
if args[:2] == ["cloudformation", "describe-stacks"]:
    outputs = {
        "MicrovmArtifactBucketName": "test-artifacts",
        "MicrovmArtifactObjectKey": "microvm-images/agent-artifact.zip",
        "MicrovmBuildRoleArn": "arn:aws:iam::123456789012:role/test",
        "MicrovmEgressConnectorArns": "runtime-connector",
        "MicrovmBuildEgressConnectorArns": "build-connector",
        "MicrovmLogGroupName": "/aws/lambda-microvms/test",
    }
    if os.environ.get("MICROVM_TEST_BASE_KEY"):
        outputs["MicrovmArtifactBaseObjectKey"] = os.environ["MICROVM_TEST_BASE_KEY"]
    print(json.dumps({"Stacks": [{"Outputs": [
        {"OutputKey": k, "OutputValue": v} for k,v in outputs.items()
    ]}]}))
elif args[:2] == ["s3api", "put-object"]:
    if os.environ.get("MICROVM_TEST_PUT_ERROR"):
        print("An error occurred (AccessDenied) when calling PutObject", file=sys.stderr)
        sys.exit(254)
    data = pathlib.Path(arg("--body")).read_bytes()
    checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
    assert arg("--checksum-sha256") == checksum
    target = store / pathlib.PurePosixPath(arg("--key")).name
    if "--if-none-match" in args:
        assert arg("--if-none-match") == "*"
        if target.exists():
            print("An error occurred (PreconditionFailed) when calling PutObject", file=sys.stderr)
            sys.exit(254)
    target.write_bytes(data)
    print(json.dumps({"ChecksumSHA256": checksum}))
elif args[:2] == ["s3api", "head-object"]:
    data = (store / pathlib.PurePosixPath(arg("--key")).name).read_bytes()
    print("invalid-checksum" if os.environ.get("MICROVM_TEST_BAD_CHECKSUM") else
          base64.b64encode(hashlib.sha256(data).digest()).decode())
elif args[:2] == ["lambda-microvms", "create-microvm-image"]:
    print(json.dumps({"imageArn": "arn:aws:lambda:us-west-2:123456789012:microvm-image:test",
                      "imageVersion": "1.0"}))
else:
    print("Unexpected AWS operation: " + repr(args), file=sys.stderr)
    sys.exit(2)
`;

describe('MicroVM artifact packaging and immutable publication', () => {
  let fixture: string;
  let store: string;

  function write(relative: string, contents: string): void {
    const filename = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }

  function packageArtifact(extraEnv: Record<string, string> = {}, args: string[] = []) {
    return spawnSync('bash', [
      path.join(fixture, 'cdk/scripts/package-microvm-artifact.sh'), ...args,
    ], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
        MICROVM_TEST_STORE: store,
        ...extraEnv,
      },
    });
  }

  function uploads(): string[][] {
    return fs.readFileSync(path.join(store, 'calls.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as string[])
      .filter(args => args[0] === 's3api' && args[1] === 'put-object');
  }

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-microvm-package-test-'));
    store = path.join(fixture, 'store');
    fs.mkdirSync(store);
    for (const name of ['package-microvm-artifact.sh', 'build-microvm-artifact.py']) {
      write(`cdk/scripts/${name}`, fs.readFileSync(path.join(REPO, 'scripts', name), 'utf8'));
    }
    write('agent/Dockerfile', 'FROM scratch\nCOPY agent/src/ /app/src/\n');
    for (const file of BUILD_INPUTS) write(file, `contents of ${file}\n`);
    write('bin/aws', AWS);
    fs.chmodSync(path.join(fixture, 'bin/aws'), 0o755);
    fs.chmodSync(path.join(fixture, 'agent/prepare-commit-msg.sh'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  test('same inputs reuse identical bytes despite dates/caches; changed source gets a new key', () => {
    const first = packageArtifact();
    expect(first.status).toBe(0);
    const firstArgs = uploads()[0]!;
    const firstKey = firstArgs[firstArgs.indexOf('--key') + 1]!;
    const bytes = fs.readFileSync(path.join(store, path.basename(firstKey)));
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(firstKey).toBe(`microvm-images/agent-artifact-${hash}.zip`);
    expect(first.stdout).toContain(`--context microvm_artifact_sha256=${hash}`);

    fs.utimesSync(path.join(fixture, 'agent/src/runner.py'), new Date(0), new Date(0));
    write('agent/src/__pycache__/runner.pyc', 'cache');
    write('agent/.coverage', 'not a build input');
    write('agent/tests/test_runner.py', 'not a build input');
    const repeated = packageArtifact();
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain('Reusing checksum-verified existing artifact');
    expect(uploads()[1]).toContain(firstKey);
    expect(fs.readFileSync(path.join(store, path.basename(firstKey)))).toEqual(bytes);

    write('agent/src/runner.py', 'changed runtime source');
    const changed = packageArtifact();
    expect(changed.status).toBe(0);
    expect(uploads()[2]).not.toContain(firstKey);

    const archive = spawnSync('python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({i.filename: {"date": i.date_time, "mode": (i.external_attr >> 16) & 511}
                      for i in z.infolist()}))
`, path.join(store, path.basename(firstKey))], { encoding: 'utf8' });
    expect(archive.status).toBe(0);
    const entries = JSON.parse(archive.stdout);
    expect(Object.keys(entries).sort()).toEqual(['Dockerfile', ...BUILD_INPUTS].sort());
    expect(entries['agent/prepare-commit-msg.sh'].mode).toBe(0o755);
    expect(entries['agent/src/runner.py']).toEqual({ date: [1980, 1, 1, 0, 0, 0], mode: 0o644 });
  });

  test('rejects an existing object whose verified checksum differs', () => {
    expect(packageArtifact().status).toBe(0);
    const second = packageArtifact({ MICROVM_TEST_BAD_CHECKSUM: '1' });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('refusing to overwrite');
  });

  test('does not treat an authorization failure as an existing artifact', () => {
    const result = packageArtifact({ MICROVM_TEST_PUT_ERROR: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AccessDenied');
    expect(fs.readFileSync(path.join(store, 'calls.jsonl'), 'utf8')).not.toContain('head-object');
  });

  test('rejects symlinked inputs before any upload', () => {
    fs.symlinkSync(path.join(fixture, 'agent/uv.lock'), path.join(fixture, 'agent/src/linked.py'));
    const result = packageArtifact();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not contain symlinks');
    expect(uploads()).toEqual([]);
  });

  test('uses the base-key output without nesting a previous digest into the next key', () => {
    expect(packageArtifact({ MICROVM_TEST_BASE_KEY: 'custom/input.zip' }).status).toBe(0);
    const args = uploads()[0]!;
    expect(args[args.indexOf('--key') + 1]).toMatch(/^custom\/input-[a-f0-9]{64}\.zip$/);
  });

  test('keeps explicit out-of-band creation on the legacy fixed key', () => {
    const result = packageArtifact({}, [
      '--create-image', '--base-image-arn', 'arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1',
      '--base-image-version', '1',
    ]);
    expect(result.status).toBe(0);
    expect(uploads()[0]).toContain(BASE_KEY);
    expect(uploads()[0]).not.toContain('--if-none-match');
  });
});

test('the packager includes every local Dockerfile COPY source and no extra source tree', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, '../agent/Dockerfile'), 'utf8');
  const copied = dockerfile.split('\n')
    .filter(line => line.startsWith('COPY ') && !line.includes('--from='))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1))
    .map(source => source.replace(/\/$/, ''));
  const helper = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("artifact", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.INPUTS))
`, path.join(REPO, 'scripts/build-microvm-artifact.py')], { encoding: 'utf8' });
  expect(helper.status).toBe(0);
  expect(JSON.parse(helper.stdout).sort()).toEqual(copied.sort());
});
