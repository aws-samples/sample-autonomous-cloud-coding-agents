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

import { makeLinkHandler } from './shared/account-link';

export const handler = makeLinkHandler({
  surface: 'Linear',
  tableName: process.env.LINEAR_USER_MAPPING_TABLE_NAME!,
  identityAttr: 'linear_identity',
  tenantAttr: 'linear_workspace_id',
  userAttr: 'linear_user_id',
  responseAttrs: ['linear_workspace_id', 'linear_workspace_slug', 'linear_user_id', 'linear_user_name', 'linear_user_email'],
  mappingExtras: { status: 'active', link_method: 'cli' },
  dryRun: true,
  // Codes from `bgagent linear invite-user` are lower-case and case-sensitive.
  upperCaseCode: false,
});
