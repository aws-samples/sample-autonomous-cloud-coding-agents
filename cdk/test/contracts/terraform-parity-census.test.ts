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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Unit tests for the CDK ↔ Terraform parity census
 * (`scripts/check-terraform-parity.mjs`, ADR-XXX sub-decision 4 tier 1, #644).
 *
 * WHY THESE LIVE HERE. `scripts/` has no test harness of its own — the four
 * existing `scripts/check-*` guards are unit-tested nowhere, they are only
 * exercised by running them. This check is different: it is a BLOCKING gate
 * whose whole value is failing on a specific, rare event (CDK grows a new
 * resource type). A gate that has never been observed to fail is
 * indistinguishable from a gate that cannot fail, so the fail path needs a test.
 * `cdk/test/contracts/` is the closest existing convention — cross-cutting
 * invariants asserted over repo files rather than over a CDK construct — so the
 * test lands here and is picked up by the normal `mise //cdk:test` run.
 *
 * HOW. Each case builds a throwaway fixture tree (a fake `cdk.out` with one
 * template, a fake `terraform/` module, a plan JSON, an allowlist, a map) and
 * runs the real script against it via its path flags. Nothing is mocked: the
 * assertions are about the script's actual exit code and actual message, which
 * is the contract CI depends on.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-terraform-parity.mjs');

/** Exit codes are load-bearing: CI must distinguish a parity gap from a broken harness. */
const EXIT_OK = 0;
const EXIT_PARITY_FAILURE = 1;
const EXIT_HARNESS_ERROR = 2;

/** A `terraform {}` block carrying the solution UA — the shape the gate demands. */
const VERSIONS_TF_WITH_UA = `
terraform {
  required_version = ">= 1.5.0"

  provider_meta "aws" {
    user_agent = ["md/uksb-wt64nei4u6#terraform"]
  }
}
`;

interface Fixture {
  readonly dir: string;
  readonly cdkOut: string;
  readonly terraformDir: string;
  readonly allowlist: string;
  readonly map: string;
  readonly plan: string;
}

interface FixtureOptions {
  /** CFN types the fake cdk.out emits. */
  readonly cfnTypes: readonly string[];
  /** Provider resource types the fake plan declares. */
  readonly terraformTypes: readonly string[];
  /** CFN type → provider type(s). */
  readonly mappings: Readonly<Record<string, readonly string[]>>;
  /** Allowlisted CFN types (rows are generated with valid reason/revisit cells). */
  readonly allowlisted?: readonly string[];
  /** Extra rows appended verbatim — for testing malformed-row rejection. */
  readonly rawAllowlistRows?: readonly string[];
  /** Omit the plan file entirely, to exercise graceful degradation. */
  readonly omitPlan?: boolean;
  /** Terraform module dirs to create, each mapped to its versions.tf contents. */
  readonly modules?: Readonly<Record<string, string>>;
}

const tempDirs: string[] = [];

function makeFixture(options: FixtureOptions): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-parity-'));
  tempDirs.push(dir);

  const cdkOut = path.join(dir, 'cdk.out');
  fs.mkdirSync(cdkOut);
  fs.writeFileSync(
    path.join(cdkOut, 'fixture.template.json'),
    JSON.stringify({
      Resources: Object.fromEntries(
        options.cfnTypes.map((type, i) => [`Res${i}`, { Type: type, Properties: {} }]),
      ),
    }),
  );

  const terraformDir = path.join(dir, 'terraform');
  const modules = options.modules ?? { '.': VERSIONS_TF_WITH_UA };
  for (const [rel, contents] of Object.entries(modules)) {
    const moduleDir = path.join(terraformDir, rel);
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'versions.tf'), contents);
  }

  const plan = path.join(dir, 'plan.json');
  if (options.omitPlan !== true) {
    fs.writeFileSync(
      plan,
      JSON.stringify({
        planned_values: {
          root_module: {
            resources: options.terraformTypes.map((type, i) => ({
              address: `${type}.r${i}`,
              mode: 'managed',
              type,
              name: `r${i}`,
            })),
          },
        },
      }),
    );
  }

  const rows = (options.allowlisted ?? []).map(
    (type) =>
      `| \`${type}\` | Deliberately not ported for this fixture's stated structural reason. | When the fixture scenario changes. |`,
  );
  const allowlist = path.join(dir, 'PARITY_ALLOWLIST.md');
  fs.writeFileSync(
    allowlist,
    [
      '# Fixture allowlist',
      '',
      '| CFN type | Reason not ported | Revisit when |',
      '|---|---|---|',
      ...rows,
      ...(options.rawAllowlistRows ?? []),
      '',
    ].join('\n'),
  );

  const map = path.join(dir, 'map.json');
  fs.writeFileSync(
    map,
    JSON.stringify({
      mappings: Object.fromEntries(
        Object.entries(options.mappings).map(([cfn, tf]) => [cfn, { terraform: tf }]),
      ),
    }),
  );

  return { dir, cdkOut, terraformDir, allowlist, map, plan };
}

function runCheck(fixture: Fixture): { status: number; stdout: string; stderr: string } {
  const args = [
    SCRIPT,
    '--cdk-out', fixture.cdkOut,
    '--terraform-dir', fixture.terraformDir,
    '--allowlist', fixture.allowlist,
    '--map', fixture.map,
    '--plan', fixture.plan,
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('terraform parity census — the fail path', () => {
  /**
   * THE test. Everything else in this file is supporting cast: if a newly
   * introduced, unmapped, unallowlisted CDK resource type does not turn the
   * build red, the gate is decoration.
   */
  it('FAILS when CDK grows a type that is neither implemented nor allowlisted', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table', 'AWS::Kinesis::Stream'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    }));

    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    // Must NAME the offending type — "parity failed" alone is unactionable.
    expect(result.stderr).toContain('AWS::Kinesis::Stream');
    expect(result.stderr).toContain('not in scripts/terraform-parity-map.json');
    // Must offer both remedies, so the author does not guess.
    expect(result.stderr).toContain('implement');
    expect(result.stderr).toContain('allowlist');
    // The covered type must not be dragged into the failure.
    expect(result.stderr).not.toContain('AWS::DynamoDB::Table');
  });

  it('PASSES once that same new type is allowlisted', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table', 'AWS::Kinesis::Stream'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      allowlisted: ['AWS::Kinesis::Stream'],
    }));

    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('declared not-ported:   1');
    expect(result.stdout).toContain('AWS::Kinesis::Stream');
  });

  it('FAILS when a type IS mapped but no mapped provider resource is in the plan', () => {
    // The subtler gap: someone added the mapping entry (so the type is "known")
    // but never implemented it, and never allowlisted it either.
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::SQS::Queue'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::SQS::Queue': ['aws_sqs_queue'] },
    }));

    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('maps to: aws_sqs_queue');
    expect(result.stderr).toContain('none present in the plan');
  });
});

describe('terraform parity census — types, never counts', () => {
  /**
   * The central design claim of ADR sub-decision 4. If a count crept into the
   * comparison, these two cases would fail, and the gate would be red on every
   * correct idiomatic substitution until someone muted it.
   */
  it('accepts one CFN resource EXPANDING into many provider resources', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::S3::Bucket'],
      terraformTypes: [
        'aws_s3_bucket',
        'aws_s3_bucket_versioning',
        'aws_s3_bucket_public_access_block',
        'aws_s3_bucket_server_side_encryption_configuration',
      ],
      mappings: {
        'AWS::S3::Bucket': ['aws_s3_bucket', 'aws_s3_bucket_versioning'],
      },
    }));

    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('covered by the module: 1');
  });

  it('accepts many CFN resources COLLAPSING into a single provider resource', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::EC2::VPC', 'AWS::EC2::InternetGateway', 'AWS::EC2::VPCGatewayAttachment'],
      terraformTypes: ['aws_vpc', 'aws_internet_gateway'],
      mappings: {
        'AWS::EC2::VPC': ['aws_vpc'],
        'AWS::EC2::InternetGateway': ['aws_internet_gateway'],
        // The attachment is expressed as `vpc_id` ON the gateway, so there is no
        // third resource. This is the archetypal legitimate collapse.
        'AWS::EC2::VPCGatewayAttachment': ['aws_internet_gateway_attachment', 'aws_internet_gateway'],
      },
    });

    expect(runCheck(fixture).status).toBe(EXIT_OK);
  });

  it('does not accept a data source as an implementation', () => {
    // A `data` block reads infrastructure; counting one as coverage would let a
    // lookup masquerade as a managed resource.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-parity-data-'));
    tempDirs.push(dir);
    const fixture = makeFixture({
      cfnTypes: ['AWS::SQS::Queue'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::SQS::Queue': ['aws_sqs_queue'] },
    });
    fs.writeFileSync(
      fixture.plan,
      JSON.stringify({
        planned_values: {
          root_module: {
            resources: [
              { address: 'data.aws_sqs_queue.x', mode: 'data', type: 'aws_sqs_queue', name: 'x' },
              { address: 'aws_dynamodb_table.t', mode: 'managed', type: 'aws_dynamodb_table', name: 't' },
            ],
          },
        },
      }),
    );

    const result = runCheck(fixture);
    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('AWS::SQS::Queue');
  });

  it('censuses nested child_modules, not just the root module', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: [],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    });
    fs.writeFileSync(
      fixture.plan,
      JSON.stringify({
        planned_values: {
          root_module: {
            resources: [],
            child_modules: [{
              address: 'module.abca',
              child_modules: [{
                address: 'module.abca.module.tables',
                resources: [{
                  address: 'aws_dynamodb_table.t',
                  mode: 'managed',
                  type: 'aws_dynamodb_table',
                  name: 't',
                }],
              }],
            }],
          },
        },
      }),
    );

    expect(runCheck(fixture).status).toBe(EXIT_OK);
  });

  it('censuses resource_changes when planned_values is absent', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: [],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    });
    fs.writeFileSync(
      fixture.plan,
      JSON.stringify({
        resource_changes: [{
          address: 'aws_dynamodb_table.t',
          mode: 'managed',
          type: 'aws_dynamodb_table',
          name: 't',
          change: { actions: ['delete'] },
        }],
      }),
    );

    expect(runCheck(fixture).status).toBe(EXIT_OK);
  });
});

describe('terraform parity census — provider_meta solution attribution (#319)', () => {
  /**
   * `provider_meta` is per-module and does NOT inherit, so a module without it
   * silently stops attributing its AWS calls. Nothing errors at apply time,
   * which is exactly why it needs a build-time assertion.
   */
  it('FAILS when a module omits provider_meta entirely', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      modules: {
        '.': VERSIONS_TF_WITH_UA,
        'submodule': 'terraform {\n  required_version = ">= 1.5.0"\n}\n',
      },
    }));

    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('submodule');
    expect(result.stderr).toContain('provider_meta');
    // The remedy must be a copy-pasteable block, not just a complaint.
    expect(result.stderr).toContain('md/uksb-wt64nei4u6#terraform');
  });

  it('FAILS when provider_meta is present but carries the WRONG solution id', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      modules: {
        '.': `
terraform {
  provider_meta "aws" {
    user_agent = ["md/some-other-solution#terraform"]
  }
}
`,
      },
    }));

    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('provider_meta');
  });

  it('FAILS when provider_meta sits OUTSIDE the terraform block', () => {
    // Not valid HCL in that position, so it would never take effect. Accepting it
    // would pass a module that has silently lost attribution.
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      modules: {
        '.': `
provider_meta "aws" {
  user_agent = ["md/uksb-wt64nei4u6#terraform"]
}
`,
      },
    }));

    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('provider_meta');
  });

  it('does NOT accept the UA string when it only appears in a comment', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      modules: {
        '.': `
# TODO: add provider_meta with md/uksb-wt64nei4u6#terraform
terraform {
  required_version = ">= 1.5.0"
}
`,
      },
    }));

    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('provider_meta');
  });

  it('PASSES when the UA lives in a sibling .tf file of the same module', () => {
    // The block may live in ANY .tf file in the directory — a Terraform module is
    // a directory, and `versions.tf` is only a convention.
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      modules: { '.': 'terraform {\n  required_version = ">= 1.5.0"\n}\n' },
    });
    fs.writeFileSync(path.join(fixture.terraformDir, 'ua.tf'), VERSIONS_TF_WITH_UA);

    expect(runCheck(fixture).status).toBe(EXIT_OK);
  });

  it('runs the provider_meta assertion even when the census is skipped', () => {
    // The credential-free half of the gate must never be skipped along with the
    // plan-dependent half.
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: [],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      omitPlan: true,
      modules: { '.': 'terraform {\n  required_version = ">= 1.5.0"\n}\n' },
    });

    const result = runCheck(fixture);
    expect(result.status).toBe(EXIT_PARITY_FAILURE);
    expect(result.stderr).toContain('provider_meta');
  });
});

describe('terraform parity census — graceful degradation', () => {
  it('SKIPS with exit 0 and a reproducible command when the plan is absent', () => {
    // Deliberate: the check is wired into `mise run build` while terraform/ is
    // still being built out across a PR stack. A hard failure here would redden
    // the build for changes unrelated to Terraform — the fastest way to get a
    // gate disabled.
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table', 'AWS::Kinesis::Stream'],
      terraformTypes: [],
      mappings: {},
      omitPlan: true,
    }));

    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('SKIPPED');
    // The skip must be loud enough to act on.
    expect(result.stdout).toContain('terraform show -json');
    expect(result.stdout).toContain('-refresh=false');
  });
});

describe('terraform parity census — fails loud, never open', () => {
  /**
   * A malformed input must not read as "no gaps found". Every case here would
   * otherwise be a way to silently disarm a blocking gate, so each is exit 2 —
   * distinct from exit 1 so CI can tell a broken harness from a real gap.
   */
  it('rejects a plan JSON with zero managed resources', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: [],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    });

    const result = runCheck(fixture);
    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('ZERO managed resource types');
  });

  it('rejects an allowlist row whose reason is a placeholder', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      rawAllowlistRows: ['| `AWS::Kinesis::Stream` | TBD | later |'],
    }));

    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('no real reason');
    expect(result.stderr).toContain('AWS::Kinesis::Stream');
  });

  it('rejects an allowlist row whose revisit-when is a placeholder', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      rawAllowlistRows: [
        '| `AWS::Kinesis::Stream` | Genuinely out of scope for the MVP module. | - |',
      ],
    }));

    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('no revisit-when');
  });

  it('rejects an allowlist row with the wrong column count', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      rawAllowlistRows: ['| `AWS::Kinesis::Stream` | Missing the revisit-when column entirely. |'],
    }));

    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('expected exactly 3');
  });

  it('rejects a duplicate allowlist row for one type', () => {
    const result = runCheck(makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
      allowlisted: ['AWS::Kinesis::Stream'],
      rawAllowlistRows: [
        '| `AWS::Kinesis::Stream` | A second, contradictory decision for the same type. | Never. |',
      ],
    }));

    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('duplicate allowlist row');
  });

  it('rejects an empty cdk.out rather than reporting zero gaps', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    });
    fs.rmSync(path.join(fixture.cdkOut, 'fixture.template.json'));

    const result = runCheck(fixture);
    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('no *.template.json');
  });

  it('rejects a template resource with no Type', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    });
    fs.writeFileSync(
      path.join(fixture.cdkOut, 'fixture.template.json'),
      JSON.stringify({ Resources: { Broken: { Properties: {} } } }),
    );

    const result = runCheck(fixture);
    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('has no string `Type`');
  });

  it('rejects a missing allowlist file (empty is valid, absent is not)', () => {
    const fixture = makeFixture({
      cfnTypes: ['AWS::DynamoDB::Table'],
      terraformTypes: ['aws_dynamodb_table'],
      mappings: { 'AWS::DynamoDB::Table': ['aws_dynamodb_table'] },
    });
    fs.rmSync(fixture.allowlist);

    const result = runCheck(fixture);
    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('allowlist not found');
  });

  it('rejects an unknown CLI flag instead of ignoring it', () => {
    // A silently-ignored `--plan` typo would degrade to the SKIP path and report
    // success while censusing nothing.
    const result = spawnSync(process.execPath, [SCRIPT, '--plan-typo', 'x'], { encoding: 'utf-8' });
    expect(result.status).toBe(EXIT_HARNESS_ERROR);
    expect(result.stderr).toContain('unknown argument');
  });
});

describe('terraform parity census — the committed configuration', () => {
  it('every CFN type in the real cdk.out is either mapped or allowlisted', () => {
    // Guards the map/allowlist pair itself: a type present in cdk.out but absent
    // from both is precisely the gate's failure condition, and this surfaces it
    // in `mise //cdk:test` even when no Terraform plan has been generated.
    const cdkOut = path.join(REPO_ROOT, 'cdk', 'cdk.out');
    const templates = fs.existsSync(cdkOut)
      ? fs.readdirSync(cdkOut).filter((f) => f.endsWith('.template.json'))
      : [];
    if (templates.length === 0) {
      // `cdk synth` has not run in this tree; the script itself errors on this,
      // so there is nothing to assert here.
      return;
    }

    const cfnTypes = new Set<string>();
    for (const file of templates) {
      const template = JSON.parse(fs.readFileSync(path.join(cdkOut, file), 'utf-8'));
      for (const resource of Object.values<{ Type?: string }>(template.Resources ?? {})) {
        if (typeof resource.Type === 'string') cfnTypes.add(resource.Type);
      }
    }

    const map = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'terraform-parity-map.json'), 'utf-8'),
    );
    const allowlistText = fs.readFileSync(
      path.join(REPO_ROOT, 'terraform', 'PARITY_ALLOWLIST.md'),
      'utf-8',
    );

    const unknown = [...cfnTypes].filter(
      (type) => !(type in map.mappings) && !allowlistText.includes(`\`${type}\``),
    );
    expect(unknown).toEqual([]);
  });

  it('the real terraform/ modules all declare the solution UA', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
    // Either OK or SKIPPED (no plan yet) — but never a provider_meta failure.
    expect(result.stderr).not.toContain('provider_meta');
    expect(result.status).toBe(EXIT_OK);
  });
});
