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
  surface: 'Jira',
  tableName: process.env.JIRA_USER_MAPPING_TABLE_NAME!,
  identityAttr: 'jira_identity',
  tenantAttr: 'jira_cloud_id',
  userAttr: 'jira_account_id',
  responseAttrs: ['jira_cloud_id', 'jira_site_url', 'jira_account_id', 'jira_user_name', 'jira_user_email'],
  mappingExtras: { status: 'active', link_method: 'cli' },
  dryRun: true,
  // Codes from `bgagent jira invite-user` are lower-case and case-sensitive.
  upperCaseCode: false,
});
