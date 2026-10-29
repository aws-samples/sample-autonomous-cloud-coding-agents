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
 * GSI name for resolving Jira-origin tasks by tenant and issue key.
 *
 * Kept dependency-free because both CDK constructs and bundled Lambda handlers
 * use this deployment/runtime contract.
 */
export const JIRA_ISSUE_INDEX_NAME = 'JiraIssueIndex';

/**
 * GSI name for resolving Linear-origin tasks by Linear issue id. Dependency-free for
 * the same reason: handlers that imported it via the TaskTable construct bundled all
 * of aws-cdk-lib (tens of MB) and could run out of memory during Lambda init.
 */
export const LINEAR_ISSUE_INDEX_NAME = 'LinearIssueIndex';
