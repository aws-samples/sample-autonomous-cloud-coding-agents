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
 * No imports: a handler that imports a construct module bundles all of `aws-cdk-lib`
 * into its Lambda artifact, as esbuild cannot tree-shake a module whose top level
 * requires the library.
 */

/** S3 key prefix for all attachments. Layout: attachments/<user_id>/<task_id>/<attachment_id>/<filename> */
export const ATTACHMENT_OBJECT_KEY_PREFIX = 'attachments/';

/**
 * S3 key prefix for all trace artifacts. Layout:
 * ``traces/<user_id>/<task_id>.jsonl.gz``. The per-user segment is
 * what ``get-trace-url`` authorizes a presigned read against.
 */
export const TRACE_OBJECT_KEY_PREFIX = 'traces/';

/**
 * Orchestration table GSI for resolving a child ``task_id`` back to its
 * orchestration + sub-issue row.
 * PK: child_task_id. Sparse — only released children are projected.
 */
export const ORCHESTRATION_CHILD_TASK_INDEX_NAME = 'ChildTaskIndex';
