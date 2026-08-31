// Test fixtures for ts-silent-success-masking (run: semgrep test .semgrep/).
/* eslint-disable */

declare function fetchItems(): Promise<string[]>;
declare function parse(s: string): Record<string, unknown>;
declare function log(msg: string): void;

async function maskedEmptyArray(): Promise<string[]> {
  try {
    return await fetchItems();
  } catch (err) {
    // ruleid: ts-silent-success-masking
    return [];
  }
}

function maskedNull(s: string): Record<string, unknown> | null {
  try {
    return parse(s);
  } catch {
    // ruleid: ts-silent-success-masking
    return null;
  }
}

function maskedEmptyObject(s: string): Record<string, unknown> {
  try {
    return parse(s);
  } catch (err) {
    log(String(err));
    // ruleid: ts-silent-success-masking
    return {};
  }
}

function maskedUndefined(s: string): Record<string, unknown> | undefined {
  try {
    return parse(s);
  } catch {
    // ruleid: ts-silent-success-masking
    return undefined;
  }
}

function maskedEmptyString(s: string): string {
  try {
    return JSON.stringify(parse(s));
  } catch {
    // ruleid: ts-silent-success-masking
    return "";
  }
}

function okRethrow(s: string): Record<string, unknown> {
  try {
    return parse(s);
  } catch (err) {
    log(String(err));
    // ok: ts-silent-success-masking
    throw err;
  }
}

function okTypedThrow(s: string): Record<string, unknown> {
  try {
    return parse(s);
  } catch (err) {
    // ok: ts-silent-success-masking
    throw new Error(`parse failed: ${String(err)}`);
  }
}

function okMeaningfulFallback(s: string): Record<string, unknown> {
  try {
    return parse(s);
  } catch {
    // ok: ts-silent-success-masking
    return { error: true };
  }
}

function maskedWithFinally(s: string): string[] {
  try {
    return [s];
  } catch {
    // ruleid: ts-silent-success-masking
    return [];
  } finally {
    log("done");
  }
}

// A conditional rethrow does not clear the fallthrough default: callers that
// hit the non-fatal path still cannot distinguish failure from empty success.
function maskedConditionalRethrow(s: string): Record<string, unknown> | null {
  try {
    return parse(s);
  } catch (err) {
    if (s.length > 0) {
      throw err;
    }
    // ruleid: ts-silent-success-masking
    return null;
  }
}

function okReturnInTryBody(items: string[]): string[] {
  try {
    if (items.length === 0) {
      // ok: ts-silent-success-masking
      return [];
    }
    return items.map((i) => i.trim());
  } catch (err) {
    throw new Error(`trim failed: ${String(err)}`);
  }
}
