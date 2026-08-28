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

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LinearVaultConsentPage, renderConsentPage } from '../../src/constructs/linear-vault-consent-page';

function synth(): { template: Template; page: LinearVaultConsentPage } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const page = new LinearVaultConsentPage(stack, 'LinearVaultConsentPage');
  return { template: Template.fromStack(stack), page };
}

describe('LinearVaultConsentPage construct', () => {
  test('serves the page from a PRIVATE bucket via CloudFront + OAC', () => {
    const { template } = synth();
    // Bucket blocks all public access — the page is public via CloudFront only.
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
    // The bucket policy must grant the distribution, never a wildcard principal.
    const policies = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toContain('cloudfront.amazonaws.com');
    expect(policies).not.toContain('"Principal":"*"');
  });

  test('exposes an https consent URL on the distribution domain', () => {
    const { page } = synth();
    // Unresolved token at synth; assert the shape we build around it.
    expect(page.consentUrl.startsWith('https://')).toBe(true);
    expect(page.consentUrl.endsWith('/')).toBe(true);
  });
});

describe('the consent page itself', () => {
  const html = renderConsentPage();

  test('renders the session id with textContent, NEVER innerHTML (reflected-XSS guard)', () => {
    // The session id arrives in the query string, so it is untrusted input
    // reflected onto the page. Assigning it as markup would turn a static page
    // into a reflected-XSS vector — this is the one line that must not regress.
    expect(html).toContain('session.textContent = sessionId');
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('document.write');
    expect(html).not.toContain('outerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
    // No eval-style sinks either.
    expect(html).not.toMatch(/\beval\(/);
  });

  test('is self-contained — no external scripts, styles, fonts or images', () => {
    // Renders on a locked-down browser, and has nothing to exfiltrate the session
    // id to.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  test('reads session_id from the query string and tells the operator what to run', () => {
    expect(html).toContain("params.get('session_id')");
    expect(html).toContain('bgagent linear vault-setup');
  });

  test('degrades to a clear message when opened without a session_id', () => {
    expect(html).toContain('Nothing to finish here');
  });

  test('asks not to be indexed (it is a one-shot operator landing page)', () => {
    expect(html).toContain('noindex');
  });
});

/**
 * Execute the page's inline script against a minimal DOM shim.
 *
 * The grep-based assertions above prove a dangerous sink is ABSENT; these prove the
 * page actually BEHAVES correctly — that it reads the right query parameter, writes
 * to the right elements, and treats a hostile session id as text. A typo in an
 * element id or param name would sail past a grep and only surface in a browser.
 */
function runPageScript(search: string): {
  title: string;
  lede: string;
  session?: string;
  command?: string;
  removed: string[];
  markupWrites: string[];
} {
  const html = renderConsentPage();
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  const removed: string[] = [];
  const markupWrites: string[] = [];
  const make = (id: string) => {
    const el: Record<string, unknown> = {
      id,
      _text: '',
      remove: () => { removed.push(id); },
    };
    Object.defineProperty(el, 'textContent', {
      get: () => el._text as string,
      set: (v: unknown) => { el._text = String(v); },
    });
    // Any attempt to write markup is recorded rather than silently allowed.
    for (const sink of ['innerHTML', 'outerHTML']) {
      Object.defineProperty(el, sink, {
        set: () => { markupWrites.push(`${id}.${sink}`); },
        get: () => '',
      });
    }
    return el;
  };
  const els: Record<string, Record<string, unknown>> = {
    title: make('title'),
    lede: make('lede'),
    session: make('session'),
    hint: make('hint'),
    command: make('command'),
  };
  const sandbox = {
    window: { location: { search } },
    document: { getElementById: (id: string) => els[id] ?? null },
    URLSearchParams,
  };

  const vm = require('vm') as typeof import('vm');
  vm.runInNewContext(script, sandbox);
  return {
    title: els.title!._text as string,
    lede: els.lede!._text as string,
    session: els.session!._text as string,
    command: els.command!._text as string,
    removed,
    markupWrites,
  };
}

describe('the consent page, executed', () => {
  test('extracts session_id and renders it plus the command to run', () => {
    const id = 'urn:ietf:params:oauth:request_uri:Y2VlYThlMjc';
    const r = runPageScript(`?session_id=${encodeURIComponent(id)}`);
    expect(r.title).toBe('Linear authorized');
    expect(r.session).toBe(id);
    expect(r.command).toContain(id);
    expect(r.command).toContain('bgagent linear vault-setup');
    expect(r.markupWrites).toEqual([]);
  });

  test('a HOSTILE session id is rendered as text, never as markup', () => {
    // Behavioural XSS proof: the payload must survive verbatim as text content and
    // no markup sink may be touched. This is what the grep assertions imply but
    // cannot actually demonstrate.
    const payload = '"><img src=x onerror=alert(1)>';
    const r = runPageScript(`?session_id=${encodeURIComponent(payload)}`);
    expect(r.session).toBe(payload);
    expect(r.markupWrites).toEqual([]);
  });

  test('with no session_id it explains itself and removes the empty slots', () => {
    const r = runPageScript('');
    expect(r.title).toBe('Nothing to finish here');
    expect(r.lede).toContain('vault-setup');
    expect(r.removed).toEqual(expect.arrayContaining(['session', 'command']));
  });
});
