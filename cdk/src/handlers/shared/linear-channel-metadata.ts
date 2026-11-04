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

import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The vault fields a task needs so the AGENT can mint its own Linear token.
 *
 * Every channel_metadata builder must spread this. A builder that omits it hands the
 * agent no provider, so it falls back to a Secrets-Manager token a vault-managed
 * workspace does not have: no reactions and no state transitions, on work that
 * otherwise succeeded.
 *
 * Three checks guard it, because they fail for different reasons. Two source-level ones
 * (in the processor test files) catch a builder nobody exercised — one keys off the
 * object-literal form, the other off the assignment form, so a builder that writes onto
 * an existing object is covered too (#879). The behavioural one asserts the fields
 * actually reach `channel_metadata`.
 */
export function vaultMetadata(resolved: { providerName?: string; vaultUserId?: string }): Record<string, string> {
  return {
    ...(resolved.providerName && { linear_provider_name: resolved.providerName }),
    ...(resolved.vaultUserId && { linear_vault_user_id: resolved.vaultUserId }),
  };
}

/**
 * Resolve a Linear user to the linked ABCA platform user. ``null`` when the
 * user has no mapping or the link is still pending — the caller must refuse to
 * act, since an unlinked Linear actor cannot be attributed or billed.
 */
export async function lookupLinearPlatformUser(
  ddb: DynamoDBDocumentClient,
  userMappingTableName: string,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const result = await ddb.send(new GetCommand({
    TableName: userMappingTableName,
    Key: { linear_identity: `${workspaceId}#${userId}` },
  }));
  if (!result.Item || result.Item.status === 'pending') return null;
  return (result.Item.platform_user_id as string) ?? null;
}
