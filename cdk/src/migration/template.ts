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

export interface TemplateResource {
  Type: string;
  Properties?: Record<string, any>;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  [key: string]: any;
}

export interface MigrationTemplate {
  Resources: Record<string, TemplateResource>;
  Parameters?: Record<string, any>;
  Conditions?: Record<string, any>;
  Outputs?: Record<string, any>;
  [key: string]: any;
}

/** Template digests use code-unit key order; runtime receipts use localeCompare. Do not interchange persisted hashes. */
export function canonical(value: unknown): string {
  const sort = (item: any): any => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]));
    }
    return item;
  };
  return JSON.stringify(sort(value)) ?? 'undefined';
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** References in prose, asset names and metadata are not CloudFormation dependencies. */
export function references(value: unknown): Set<string> {
  const result = new Set<string>();
  const visit = (item: any): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item.Ref === 'string') result.add(item.Ref);
    const attribute = item['Fn::GetAtt'];
    if (Array.isArray(attribute) && typeof attribute[0] === 'string') result.add(attribute[0]);
    if (typeof attribute === 'string') result.add(attribute.split('.')[0]!);
    const substitution = item['Fn::Sub'];
    if (substitution !== undefined) {
      const expression = typeof substitution === 'string' ? substitution : substitution[0];
      const bindings = typeof substitution === 'string' ? {} : substitution[1] ?? {};
      if (typeof expression !== 'string') throw new Error('Invalid Fn::Sub in migration template');
      for (const match of expression.matchAll(/\$\{([^}]+)\}/g)) {
        const token = match[1]!;
        if (token.startsWith('!') || Object.hasOwn(bindings, token)) continue;
        result.add(token.split('.')[0]!);
      }
      visit(bindings);
    }
    for (const [key, child] of Object.entries(item)) {
      if (key !== 'Fn::Sub' && key !== 'Metadata') visit(child);
    }
  };
  visit(value);
  return result;
}

export function referencesAny(value: unknown, ids: ReadonlySet<string>): boolean {
  return [...references(value)].some(id => ids.has(id));
}

/** Refuse incomplete staged templates before publishing any asset or change set. */
export function validateTemplate(template: MigrationTemplate, label: string): void {
  if (!template.Resources || typeof template.Resources !== 'object'
    || Array.isArray(template.Resources) || !Object.keys(template.Resources).length) {
    throw new Error(`${label}: template must contain resources`);
  }
  const count = Object.keys(template.Resources).length;
  if (count > 500) throw new Error(`${label}: ${count} resources exceed the CloudFormation limit of 500`);
  if (Buffer.byteLength(JSON.stringify(template)) > 1024 * 1024) {
    throw new Error(`${label}: template exceeds the CloudFormation 1 MiB limit`);
  }
  for (const section of ['Parameters', 'Outputs'] as const) {
    if (Object.keys(template[section] ?? {}).length > 200) {
      throw new Error(`${label}: ${section} exceeds the CloudFormation limit of 200`);
    }
  }
  const known = new Set([...Object.keys(template.Resources), ...Object.keys(template.Parameters ?? {})]);
  for (const ref of references(template)) {
    if (!known.has(ref) && !ref.startsWith('AWS::')) {
      throw new Error(`${label}: unresolved reference ${ref}`);
    }
  }
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (!resource || typeof resource.Type !== 'string') throw new Error(`${label}: invalid resource ${id}`);
    const dependencies = resource.DependsOn
      ? (Array.isArray(resource.DependsOn) ? resource.DependsOn : [resource.DependsOn])
      : [];
    for (const dependency of dependencies) {
      if (!template.Resources[dependency]) throw new Error(`${label}: ${id} depends on missing ${dependency}`);
    }
  }
}

export interface TemplateDelta {
  added: string[];
  removed: string[];
  modified: string[];
}

export function templateDelta(before: MigrationTemplate, after: MigrationTemplate): TemplateDelta {
  return {
    added: Object.keys(after.Resources).filter(id => !before.Resources[id]).sort(),
    removed: Object.keys(before.Resources).filter(id => !after.Resources[id]).sort(),
    modified: Object.keys(after.Resources).filter(id =>
      before.Resources[id] && canonical(before.Resources[id]) !== canonical(after.Resources[id]),
    ).sort(),
  };
}
