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

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, Json } from '../utils/canonical-json';

export { canonicalJson };

type JsonObject = { [key: string]: Json };

export interface TemplateCensus {
  readonly file: string;
  readonly resources: number;
  readonly bytes: number;
  readonly parameters: number;
  readonly outputs: number;
  readonly types: Readonly<Record<string, number>>;
  readonly sha256: string;
  readonly semanticSha256: string;
  readonly inventory: readonly {
    logicalId: string;
    type: string;
    constructPath?: string;
    /** Explicit template policies; null leaves CloudFormation's type-specific default unspecified. */
    deletionPolicy: Json;
    updateReplacePolicy: Json;
  }[];
}

export interface AssemblyCensus {
  readonly templates: readonly TemplateCensus[];
  readonly nestedEdges: readonly { parent: string; child: string }[];
  /** Direct stack dependencies, identified by assembly-relative template paths. Asset artifacts are excluded. */
  readonly stackDependencies: Readonly<Record<string, readonly string[]>>;
  readonly errors: readonly string[];
  /** Sum over distinct template artifacts, not the number of deployed instances. */
  readonly totalResources: number;
}

function object(value: Json | undefined, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${label}`);
  return value;
}

function readJson(file: string): JsonObject {
  return object(JSON.parse(readFileSync(file, 'utf8')) as Json, file);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function childPath(directory: string, relative: Json | undefined): string {
  if (typeof relative !== 'string') throw new Error(`Missing local template/assembly path in ${directory}`);
  const base = realpathSync(directory);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Template/assembly path escapes its directory: ${relative}`);
  }
  const physical = realpathSync(resolved);
  if (!physical.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Template/assembly path escapes its directory through a symlink: ${relative}`);
  }
  return physical;
}

interface TemplateAsset {
  readonly file: string;
  readonly objectKey: string;
}

function stringValues(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}

function nestedTemplate(resource: JsonObject, directory: string, assets: readonly TemplateAsset[]): string {
  const metadata = object(resource.Metadata ?? {}, 'nested stack metadata');
  if (metadata['aws:asset:path']) return childPath(directory, metadata['aws:asset:path']);
  const url = object(resource.Properties ?? {}, 'nested stack properties').TemplateURL;
  const strings = stringValues(url);
  const matches = new Set(assets.filter(asset =>
    strings.some(value => value === asset.objectKey || value.endsWith(`/${asset.objectKey}`)),
  ).map(asset => asset.file));
  if (matches.size !== 1) throw new Error(`Missing local template path or ambiguous nested template asset in ${directory}`);
  return childPath(directory, path.relative(directory, [...matches][0]));
}

/** Follow assembly/asset manifests and nested-template metadata, never a directory glob. */
export function inspectAssembly(directory: string): AssemblyCensus {
  const root = realpathSync(directory);
  const templates = new Map<string, TemplateCensus>();
  const nestedEdges: { parent: string; child: string }[] = [];
  const stackDependencies: Record<string, string[]> = {};
  const errors: string[] = [];
  const visiting = new Set<string>();

  function visitTemplate(file: string, assets: readonly TemplateAsset[]): void {
    const name = path.relative(root, file);
    if (visiting.has(file)) throw new Error(`Nested template cycle at ${name}`);
    if (templates.has(name)) return;
    visiting.add(file);
    const raw = readFileSync(file, 'utf8');
    const template = object(JSON.parse(raw) as Json, name);
    const resources = object(template.Resources ?? {}, `${name}/Resources`);
    const types: Record<string, number> = {};
    const inventory = Object.entries(resources).map(([logicalId, value]) => {
      const resource = object(value, logicalId);
      if (typeof resource.Type !== 'string') throw new Error(`Missing resource type: ${name}/${logicalId}`);
      types[resource.Type] = (types[resource.Type] ?? 0) + 1;
      const metadata = object(resource.Metadata ?? {}, `${logicalId}/Metadata`);
      if (resource.Type === 'AWS::CloudFormation::Stack') {
        const child = nestedTemplate(resource, path.dirname(file), assets);
        nestedEdges.push({ parent: name, child: path.relative(root, child) });
        visitTemplate(child, assets);
      }
      return {
        logicalId,
        type: resource.Type,
        ...(typeof metadata['aws:cdk:path'] === 'string' ? { constructPath: metadata['aws:cdk:path'] } : {}),
        deletionPolicy: resource.DeletionPolicy ?? null,
        updateReplacePolicy: resource.UpdateReplacePolicy ?? null,
      };
    });
    templates.set(name, {
      file: name,
      resources: inventory.length,
      bytes: Buffer.byteLength(raw),
      parameters: Object.keys(object(template.Parameters ?? {}, `${name}/Parameters`)).length,
      outputs: Object.keys(object(template.Outputs ?? {}, `${name}/Outputs`)).length,
      types,
      sha256: sha256(raw),
      semanticSha256: sha256(canonicalJson(template)),
      inventory,
    });
    visiting.delete(file);
  }

  function visitManifest(dir: string): void {
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const artifacts = object(manifest.artifacts, 'artifacts');
    const missing = manifest.missing ?? [];
    if (!Array.isArray(missing)) throw new Error('Invalid missing-context entries');
    for (const value of missing) {
      const lookup = object(value, 'missing context');
      if (typeof lookup.key !== 'string' || typeof lookup.provider !== 'string') throw new Error('Invalid missing-context entry');
      errors.push(`Unresolved CDK context in ${path.relative(root, dir) || '.'}: ${lookup.key} (${lookup.provider})`);
    }
    const assetsByArtifact = new Map<string, TemplateAsset[]>();
    for (const [assetManifestId, artifactValue] of Object.entries(artifacts)) {
      const artifact = object(artifactValue, 'artifact');
      if (artifact.type !== 'cdk:asset-manifest') continue;
      const assets: TemplateAsset[] = [];
      assetsByArtifact.set(assetManifestId, assets);
      const properties = object(artifact.properties, 'asset manifest properties');
      const assetFile = childPath(dir, properties.file);
      const assetManifest = readJson(assetFile);
      for (const assetValue of Object.values(object(assetManifest.files ?? {}, 'file assets'))) {
        const asset = object(assetValue, 'asset');
        const source = object(asset.source, 'asset source');
        if (source.packaging !== 'file') continue;
        if (typeof source.path !== 'string') throw new Error('Missing asset source path');
        for (const destinationValue of Object.values(object(asset.destinations, 'asset destinations'))) {
          const destination = object(destinationValue, 'destination');
          if (typeof destination.objectKey !== 'string') throw new Error('Missing asset object key');
          // Unstaged file assets may live outside the assembly. Only validate
          // containment when the asset is actually a referenced nested template.
          assets.push({ file: path.resolve(path.dirname(assetFile), source.path), objectKey: destination.objectKey });
        }
      }
    }
    for (const [id, value] of Object.entries(artifacts)) {
      const artifact = object(value, id);
      const properties = object(artifact.properties ?? {}, `${id}/properties`);
      const metadataSources = [object(artifact.metadata ?? {}, `${id}/metadata`)];
      if (artifact.additionalMetadataFile) metadataSources.push(readJson(childPath(dir, artifact.additionalMetadataFile)));
      for (const metadata of metadataSources) {
        for (const [scope, entries] of Object.entries(metadata)) {
          if (!Array.isArray(entries)) throw new Error(`Expected metadata array: ${scope}`);
          for (const entry of entries) {
            const annotation = object(entry, scope);
            if (annotation.type === 'aws:cdk:error') errors.push(`${scope}: ${String(annotation.data)}`);
          }
        }
      }
      if (artifact.type === 'aws:cloudformation:stack') {
        const file = childPath(dir, properties.templateFile);
        const dependencies = artifact.dependencies ?? [];
        if (!Array.isArray(dependencies) || dependencies.some(v => typeof v !== 'string')) {
          throw new Error(`Invalid dependencies: ${id}`);
        }
        const dependencyIds = dependencies as string[];
        const name = path.relative(root, file);
        if (Object.hasOwn(stackDependencies, name)) throw new Error(`Multiple stack artifacts reference ${name}`);
        stackDependencies[name] = [...new Set(dependencyIds.flatMap(dependency => {
          if (!Object.hasOwn(artifacts, dependency)) {
            throw new Error(`Unknown dependency of ${id}: ${dependency}`);
          }
          const target = object(artifacts[dependency], dependency);
          if (target.type !== 'aws:cloudformation:stack') return [];
          const targetProperties = object(target.properties, `${dependency}/properties`);
          return [path.relative(root, childPath(dir, targetProperties.templateFile))];
        }))].sort();
        // Different stacks can publish identical child contents under the same
        // asset hash. Resolve only through this stack's own asset manifests.
        visitTemplate(file, dependencyIds.flatMap(dependency => assetsByArtifact.get(dependency) ?? []));
      } else if (artifact.type === 'cdk:cloud-assembly') {
        visitManifest(childPath(dir, properties.directoryName));
      }
    }
  }

  visitManifest(root);
  if (!templates.size) throw new Error(`No stack templates found in ${root}`);
  const checked = new Set<string>();
  function checkDependencies(file: string): void {
    if (visiting.has(file)) throw new Error(`Stack dependency cycle at ${file}`);
    if (checked.has(file)) return;
    visiting.add(file);
    for (const dependency of stackDependencies[file]) checkDependencies(dependency);
    visiting.delete(file);
    checked.add(file);
  }
  for (const file of Object.keys(stackDependencies)) checkDependencies(file);
  const measured = [...templates.values()].sort((a, b) => a.file.localeCompare(b.file));
  return {
    templates: measured,
    nestedEdges,
    stackDependencies,
    errors,
    totalResources: measured.reduce((sum, template) => sum + template.resources, 0),
  };
}

export interface AssemblyDifference {
  readonly kind: 'template' | 'stack-dependencies';
  readonly file: string;
  /** JSON pointers within a template; empty for dependencies stored in assembly manifests. */
  readonly paths: readonly string[];
  readonly totalDifferences: number;
}

/** JSON-pointer paths only: diagnostics do not print resource property values. */
export function compareAssemblies(first: string, second: string): readonly AssemblyDifference[] {
  const a = inspectAssembly(first);
  const b = inspectAssembly(second);
  const names = [...new Set([...a.templates, ...b.templates].map(t => t.file))].sort();
  const differences: AssemblyDifference[] = names.flatMap(file => {
    const left = a.templates.find(t => t.file === file);
    const right = b.templates.find(t => t.file === file);
    if (left?.semanticSha256 === right?.semanticSha256) return [];
    if (!left || !right) return [{ kind: 'template' as const, file, paths: ['/'], totalDifferences: 1 }];
    const paths: string[] = [];
    let totalDifferences = 0;
    function visit(x: Json | undefined, y: Json | undefined, pointer: string): void {
      if (x !== undefined && y !== undefined && canonicalJson(x) === canonicalJson(y)) return;
      if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
        for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
          visit(x[key], y[key], `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
        }
      } else {
        totalDifferences++;
        if (paths.length < 100) paths.push(pointer || '/');
      }
    }
    visit(readJson(path.join(first, file)), readJson(path.join(second, file)), '');
    return [{ kind: 'template' as const, file, paths, totalDifferences }];
  });
  for (const file of [...new Set([...Object.keys(a.stackDependencies), ...Object.keys(b.stackDependencies)])].sort()) {
    const left = a.stackDependencies[file];
    const right = b.stackDependencies[file];
    if (!left || !right || canonicalJson([...left]) !== canonicalJson([...right])) {
      differences.push({ kind: 'stack-dependencies', file, paths: [], totalDifferences: 1 });
    }
  }
  return differences;
}
