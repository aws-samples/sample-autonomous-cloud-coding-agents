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

import Link, { type LinkProps } from '@cloudscape-design/components/link';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

/** Cloudscape link styling with client-side navigation for in-app routes. */
export function RouterLink({ href, children, ...rest }: Omit<LinkProps, 'onFollow' | 'external'> & { href: string }) {
  const navigate = useNavigate();
  return (
    <Link
      {...rest}
      href={href}
      onFollow={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </Link>
  );
}

/** Opens outside the console (for example a pull request) in a new tab. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} external target="_blank" rel="noopener noreferrer">{children}</Link>;
}
