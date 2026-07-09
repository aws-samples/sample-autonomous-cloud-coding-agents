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

/**
 * Resolve event rules from inline config and registry pack pins (#230 Phase 3).
 *
 * Packs are authored alongside workflows under ``agent/event-rules/packs/*.json``
 * and bundled into the resolver at build time. Until the agent asset registry
 * (#246) ships, this file IS the registry; the resolver interface matches the
 * future ``RegistryService.resolve('event-rule-pack')`` so the swap is local.
 */

import type { EventRule, EventRulePackRef } from './event-governance-types';
import { parseEventRules } from './event-rule-evaluator';
import platformDefaultPack from '../../../../agent/event-rules/packs/platform-default-v1.json';

interface PackFile {
  readonly pack_id?: string;
  readonly pack_version?: string;
  readonly rules: unknown;
}

function loadPackFile(file: PackFile): { id: string; version: string; rules: readonly EventRule[] } {
  const id = file.pack_id ?? 'unknown';
  const version = file.pack_version ?? '0.0.0';
  return { id, version, rules: parseEventRules(file.rules) };
}

/** Builtin registry — swap for #246 RegistryService when available. */
const BUILTIN_PACKS: Readonly<Record<string, Readonly<Record<string, readonly EventRule[]>>>> = (() => {
  const loaded = loadPackFile(platformDefaultPack as PackFile);
  const byVersion: Record<string, readonly EventRule[]> = {
    [loaded.version]: loaded.rules,
  };
  return {
    [loaded.id]: byVersion,
    // Alias for blueprint pins using the filename stem.
    'platform-default-v1': byVersion,
  };
})();

export function listBuiltinEventRulePacks(): ReadonlyArray<{
  readonly id: string;
  readonly version: string;
  readonly rule_count: number;
}> {
  const loaded = loadPackFile(platformDefaultPack as PackFile);
  return [{
    id: loaded.id,
    version: loaded.version,
    rule_count: loaded.rules.length,
  }];
}

/** Thrown when a blueprint/workflow pins an event-rule-pack that does not
 *  resolve. Fail loud rather than silently applying zero governance rules —
 *  a mis-pinned pack must surface at submit / via the API, not leave a task
 *  running with a ceiling rule that was never loaded (#230). */
export class UnknownEventRulePackError extends Error {
  constructor(public readonly packRef: EventRulePackRef) {
    super(`Unknown event-rule-pack pin: ${packRef.id}@${packRef.version}. `
      + 'No such pack/version is bundled; check the Blueprint\'s security.eventRulePack.');
    this.name = 'UnknownEventRulePackError';
  }
}

export function resolveEventRules(options: {
  readonly inlineRules?: readonly EventRule[];
  readonly packRef?: EventRulePackRef;
}): EventRule[] {
  const inline = options.inlineRules ?? [];
  if (!options.packRef) return [...inline];

  const versionMap = BUILTIN_PACKS[options.packRef.id];
  const packRules = versionMap?.[options.packRef.version];
  if (packRules === undefined) {
    throw new UnknownEventRulePackError(options.packRef);
  }
  if (inline.length === 0) {
    return packRules.map(r => ({
      ...r,
      rule_pack_id: options.packRef?.id,
    }));
  }

  const inlineById = new Map(inline.map(r => [r.id, r] as const));
  const merged = packRules.map(r => {
    const override = inlineById.get(r.id);
    return override ?? { ...r, rule_pack_id: options.packRef?.id };
  });
  for (const rule of inline) {
    if (!packRules.some(r => r.id === rule.id)) merged.push(rule);
  }
  return merged;
}
