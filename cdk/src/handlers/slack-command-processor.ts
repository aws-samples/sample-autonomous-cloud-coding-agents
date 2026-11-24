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

import * as crypto from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import { lookupRepo } from './shared/repo-config';
import { slackFetch } from './shared/slack-api';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';
import type { Attachment } from './shared/types';
import { makeDocClient } from './shared/ua';
import { MAX_INLINE_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_INLINE_SIZE_BYTES } from './shared/validation';
import { CODING_WORKFLOW_ID } from './shared/workflows';
import type { SlackCommandPayload } from './slack-commands';

/**
 * Payload fields every inbound event carries, whether it came from a slash
 * command or an @mention.
 */
interface BasePayload {
  readonly text: string;
  readonly user_id: string;
  readonly team_id: string;
  readonly channel_id: string;
}

/** Slash-command invocation — has a usable response_url, no mention context. */
export interface SlashCommandEvent extends BasePayload, SlackCommandPayload {
  readonly source: 'slash';
}

/** Metadata for a file attached to a Slack message. */
export interface SlackFileRef {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url_private_download: string;
}

/** @mention invocation — no response_url; reply via chat.postMessage in-thread. */
export interface MentionEvent extends BasePayload {
  readonly source: 'mention';
  /** The thread to reply in: the mention itself, or the thread it was written in. */
  readonly mention_thread_ts?: string;
  /** The mention itself, which carries the progress reactions. */
  readonly mention_message_ts?: string;
  readonly files?: readonly SlackFileRef[];
}

/** Discriminated union of the inbound events the processor accepts. */
export type CommandProcessorEvent = SlashCommandEvent | MentionEvent;

/**
 * Legacy shape — the slash-command acknowledger (`slack-commands.ts`) forwards
 * payloads without a `source` field. Normalize those into SlashCommandEvent so
 * the handler body only has to reason about the discriminated union.
 */
type RawEvent = CommandProcessorEvent | SlackCommandPayload;

function normalizeEvent(event: RawEvent): CommandProcessorEvent {
  if ('source' in event && event.source) {
    return event;
  }
  return { ...event, source: 'slash' };
}

const ddb = makeDocClient();

const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;
const INSTALLATION_TABLE = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const CHANNEL_MAPPING_TABLE = process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME;

/** Link code TTL. */
const LINK_CODE_TTL_S = 10 * 60; // 10 minutes

/** Random bytes for slash-command account-link codes (→ 6 hex chars). */
const LINK_CODE_ENTROPY_BYTES = 3;

/** Prefix length when logging Slack response_url values (avoid leaking tokens). */
const RESPONSE_URL_LOG_PREFIX_LEN = 80;

/**
 * Async processor for Slack slash commands and @mention triggers.
 *
 * Invoked asynchronously by the slash command acknowledger or the events handler.
 * Posts results back to Slack via `response_url` (slash commands) or
 * `chat.postMessage` (@mentions).
 */
export async function handler(raw: RawEvent): Promise<void> {
  const event = normalizeEvent(raw);
  const text = (event.text ?? '').trim();
  const parts = text.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? '';

  // Build a reply function that handles both response_url and mention modes.
  const reply = event.source === 'mention'
    ? buildMentionReply(event)
    : (msg: string) => postToSlack(event.response_url, msg);

  try {
    switch (subcommand) {
      case 'submit':
        // Submit is only used via @mentions — slash commands show usage guidance.
        if (event.source === 'mention') {
          // The message as written, line breaks included: it becomes the task description.
          await handleSubmit(event, text.slice(subcommand.length).trim(), reply);
        } else {
          await reply('Use `@Shoof` to submit tasks — e.g. `@Shoof fix the bug in org/repo#42`\nFor private submissions, DM Shoof directly.');
        }
        break;
      case 'link':
        await handleLink(event, reply);
        break;
      case 'help':
        await reply(
          '*Using Shoof*\n\n'
          + '*Submit a task:* Mention `@Shoof` in any channel:\n'
          + '> `@Shoof fix the login bug in org/repo#42`\n'
          + '> `@Shoof update the README in org/repo`\n\n'
          + '*Private submissions:* DM Shoof directly.\n\n'
          + '*Cancel a task:* Use the Cancel button in the thread.\n\n'
          + '*Link your account:* `/bgagent link` — one-time setup.\n\n'
          + 'Reactions on your message show progress: :eyes: → :hourglass_flowing_sand: → :white_check_mark:',
        );
        break;
      default:
        await reply('Use `@Shoof` to submit tasks, or `/bgagent link` to link your account.\nTry `/bgagent help` for more info.');
    }
  } catch (err) {
    logger.error('Slack command processing failed', {
      subcommand,
      error: err instanceof Error ? err.message : String(err),
      team_id: event.team_id,
      user_id: event.user_id,
    });
    await reply(':warning: Something went wrong. Please try again.');
    if (event.source === 'mention') {
      // As on every other failure, :eyes: must not stay on a request that
      // created nothing. Best-effort: an error that escapes this handler makes
      // Lambda retry the invocation and run the submission again.
      try {
        await swapReaction(event, 'eyes', 'x');
      } catch (swapErr) {
        logger.warn('Failed to mark the mention as failed', {
          error: swapErr instanceof Error ? swapErr.message : String(swapErr),
          team_id: event.team_id,
        });
      }
    }
  }
}

type ReplyFn = (text: string) => Promise<void>;

/** Build a reply function that posts in-thread via chat.postMessage for @mentions. */
function buildMentionReply(event: MentionEvent): ReplyFn {
  return async (text: string) => {
    const botToken = await getBotToken(event.team_id);
    if (!botToken) {
      logger.warn('Cannot reply to mention: bot token not found', { team_id: event.team_id });
      return;
    }
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: event.channel_id,
        text,
        thread_ts: event.mention_thread_ts,
      }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to post mention reply', { error: result.error, channel: event.channel_id });
    }
  };
}

// ─── Submit ───────────────────────────────────────────────────────────────────

/**
 * What can name a repo in a message. A link, as Slack delivers it (`<url>` or
 * `<url|label>`) or as typed, is read whole, so that its parts are not taken
 * for words. Otherwise `owner/repo` or `owner/repo#42` as a word. A word is
 * tried from its first letter, digit or underscore only: with a start at every
 * dot and hyphen, a long word takes quadratic time.
 */
const REPO_REFERENCE = /<(?<slackLink>https?:\/\/[^\s<>|]+)(?:\|[^<>]*)?>|(?<typedLink>https?:\/\/[^\s<>|]*[^\s<>|.,;:!?)])|(?=\w)(?<!\w[.-]*)(?<repo>[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?:#(?<issueNumber>\d+))?\b/gi;

/**
 * A GitHub link to a repo, or to one of its issues or pull requests. A clone
 * address (`.../owner/repo.git`) names the repo without the suffix. Without a
 * number only a query or a fragment may follow the repo, so a link to a file,
 * a branch or another page of the repo is not one of these.
 */
const GITHUB_LINK = /^https?:\/\/(?:www\.)?github\.com\/(?<repo>[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/(?:issues|pull)\/(?<issueNumber>\d+)|\/?(?:[?#].*)?$)/i;

/**
 * What a github.com path begins with, in lower case, when it is a page of the site.
 * A name that an account has must stay out, or links to its repos are ignored.
 */
const GITHUB_SITE_PAGES = new Set([
  'about', 'account', 'advisories', 'apps', 'codespaces', 'collections', 'enterprise', 'enterprises', 'features',
  'issues', 'login', 'marketplace', 'notifications', 'organizations', 'orgs', 'pulls', 'readme', 'resources',
  'search', 'security', 'settings', 'site', 'solutions', 'sponsors', 'stars', 'topics', 'trending',
]);

/** A repo named in a message, and where the word or link that names it stands. */
interface RepoReference {
  readonly repo: string;
  readonly issueNumber?: number;
  /** Written as a GitHub link or with an issue number: a repo, onboarded or not. */
  readonly certain: boolean;
  readonly start: number;
  readonly end: number;
}

/**
 * The repos a message names, in the order written. A link names the repo it
 * points to when it is a GitHub link to a repo, an issue or a pull request,
 * and no repo otherwise.
 */
function repoReferences(message: string): RepoReference[] {
  const references: RepoReference[] = [];
  for (const match of message.matchAll(REPO_REFERENCE)) {
    const groups = match.groups ?? {};
    const link = groups.slackLink ?? groups.typedLink;
    const { repo, issueNumber } = link ? (GITHUB_LINK.exec(link)?.groups ?? {}) : groups;
    if (repo && !(link && GITHUB_SITE_PAGES.has(ownerOf(repo)))) {
      references.push({
        repo,
        issueNumber: issueNumber ? parseInt(issueNumber, 10) : undefined,
        certain: Boolean(link ?? issueNumber),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return references;
}

/** The owner part of `owner/repo`, lower-cased: owners compare without case. */
function ownerOf(repo: string): string {
  return repo.split('/')[0].toLowerCase();
}

/**
 * The first of these references that certainly means a repo: it is a GitHub
 * link, it carries an issue number, or it names an onboarded repo (one
 * RepoTable read per distinct name).
 */
async function findRepoReference(references: RepoReference[]): Promise<RepoReference | undefined> {
  const notOnboarded = new Set<string>();
  for (const reference of references) {
    if (reference.certain || (!notOnboarded.has(reference.repo) && (await lookupRepo(reference.repo)).onboarded)) {
      return reference;
    }
    notOnboarded.add(reference.repo);
  }
  return undefined;
}

async function handleSubmit(event: MentionEvent, message: string, reply: ReplyFn): Promise<void> {
  if (!message) {
    await reply('Usage: `/bgagent submit org/repo#42 description`');
    return;
  }

  // Resolve platform user.
  const platformUserId = await lookupPlatformUser(event.team_id, event.user_id);
  if (!platformUserId) {
    await reply(':link: Your Slack account is not linked. Run `/bgagent link` first.');
    await swapReaction(event, 'eyes', 'x');
    return;
  }

  // Resolve the target repo. A slash-joined word is not necessarily a repo
  // ("CI/CD", "and/or", "src/handlers/foo.ts"), so the first one does not decide.
  // A repo is known when a word or a link certainly means one (findRepoReference)
  // or, failing that, when the channel has an onboarded default repo (`bgagent
  // slack onboard-channel`).
  //   1. The repo is the first word or link under the owner of the known repo,
  //      wherever it stands in "fix the bug in org/repo#42": that repo itself or,
  //      before it, a sibling or a misspelling. The rest of the message is the
  //      description, and createTaskCore reports a repo that is not onboarded.
  //   2. With no such word or link, the channel default gets the WHOLE message.
  //   3. With no repo known at all, the first slash-joined word is taken, as before.
  const references = repoReferences(message);
  const certain = await findRepoReference(references);
  const defaultRepo = certain ? null : await lookupChannelDefaultRepo(event.team_id, event.channel_id);
  const known = certain?.repo ?? defaultRepo;
  const reference = known
    ? references.find(candidate => ownerOf(candidate.repo) === ownerOf(known))
    : references[0];
  const repo = reference?.repo ?? defaultRepo;
  // The message without the word or link that named the repo and the blanks in front of it.
  const description = reference
    ? (message.slice(0, reference.start).replace(/(?<![ \t])[ \t]+$/, '') + message.slice(reference.end)).trim()
    : message;
  if (!repo) {
    await reply('Please include a repo — e.g. `@Shoof fix the bug in org/repo#42`. Or ask an admin to set a default with `bgagent slack onboard-channel`.');
    await swapReaction(event, 'eyes', 'x');
    return;
  }

  // Check if the bot can post to this channel (private channels need an invite).
  const channelCheck = await checkChannelAccess(event.team_id, event.channel_id);
  if (!channelCheck.ok) {
    await reply(channelCheck.error!);
    await swapReaction(event, 'eyes', 'x');
    return;
  }

  // handleSubmit is only invoked for the mention path, so there's no response_url.
  // Notifications thread under the user's @mention message using mention_thread_ts;
  // the reactions of the task go on the mention itself, mention_message_ts.
  const channelMetadata: Record<string, string> = {
    slack_team_id: event.team_id,
    slack_channel_id: event.channel_id,
    slack_user_id: event.user_id,
  };
  if (event.mention_thread_ts) {
    channelMetadata.slack_thread_ts = event.mention_thread_ts;
  }
  if (event.mention_message_ts) {
    channelMetadata.slack_message_ts = event.mention_message_ts;
  }

  // Extract file attachments from the Slack event (if present).
  // Files are downloaded from Slack CDN and passed as inline base64 attachments.
  const attachments = await extractSlackFileAttachments(event, reply);
  if (attachments === null) {
    // extractSlackFileAttachments already replied with the error
    await swapReaction(event, 'eyes', 'x');
    return;
  }

  // Create the task through the shared core.
  const result = await createTaskCore(
    {
      repo,
      issue_number: reference?.issueNumber,
      task_description: description || undefined,
      // Explicit coding workflow: a Slack-submitted task targets a repo, so it
      // must not fall through the resolution ladder to the repo-less
      // default/agent-v1 (which never commits or opens a PR). Mirrors the Jira
      // processor. See CODING_WORKFLOW_ID.
      workflow_ref: CODING_WORKFLOW_ID,
      ...(attachments.length > 0 && { attachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'slack',
      channelMetadata,
    },
    crypto.randomUUID(),
  );

  // Extract task info from the response.
  const body = JSON.parse(result.body);
  if (result.statusCode === 201 && body.data) {
    // The notify handler posts the task_created message in-thread — don't
    // duplicate it here on the mention path.
    return;
  }

  const errMsg = body.error?.message ?? 'Unknown error';
  await reply(`:x: Failed to create task: ${errMsg}`);
  // Swap reaction to :x: on the mention message.
  await swapReaction(event, 'eyes', 'x');
}

// ─── Link ─────────────────────────────────────────────────────────────────────

async function handleLink(event: CommandProcessorEvent, reply: ReplyFn): Promise<void> {
  // Generate a 6-character alphanumeric code.
  const code = crypto.randomBytes(LINK_CODE_ENTROPY_BYTES).toString('hex').toUpperCase();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + LINK_CODE_TTL_S;

  // Store the pending link record.
  await ddb.send(new PutCommand({
    TableName: USER_MAPPING_TABLE,
    Item: {
      slack_identity: `pending#${code}`,
      slack_team_id: event.team_id,
      slack_user_id: event.user_id,
      link_method: 'slash_command',
      linked_at: now,
      status: 'pending',
      ttl,
    },
  }));

  await reply(
    `:link: *Link your account*\n\nRun this command in your terminal:\n\`\`\`bgagent slack link ${code}\`\`\`\n_This code expires in 10 minutes._`,
  );
}

// ─── Channel Access ──────────────────────────────────────────────────────────

async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await ddb.send(new GetCommand({
    TableName: INSTALLATION_TABLE,
    Key: { team_id: teamId },
  }));
  if (!installation.Item || installation.Item.status !== 'active') return null;
  return getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
}

/** Slack error codes that definitively mean the bot cannot post in this channel. */
const CHANNEL_ACCESS_HARD_FAILURES = new Set([
  'channel_not_found', // private channel the bot hasn't been invited to
  'not_in_channel', // public channel the bot isn't in (some workspaces require join)
  'missing_scope', // bot lacks the scope it needs — admin must reinstall
]);

async function checkChannelAccess(teamId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
  // DM channels always work — notifications fall back to user ID.
  if (channelId.startsWith('D')) return { ok: true };

  const botToken = await getBotToken(teamId);
  if (!botToken) {
    logger.warn('Channel access check skipped: bot token missing', { team_id: teamId });
    return {
      ok: false,
      error: ':warning: The Slack integration is not fully configured (missing bot token). Ask your workspace admin to reinstall the app.',
    };
  }

  try {
    const response = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const result = await response.json() as { ok: boolean; channel?: { is_private: boolean; is_member: boolean }; error?: string };

    if (!result.ok) {
      // Hard failures: the bot definitively cannot post here. Fail closed so the
      // task isn't created silently into a dead-letter channel.
      if (result.error && CHANNEL_ACCESS_HARD_FAILURES.has(result.error)) {
        return { ok: false, error: ':lock: This is a private channel and the bot is not a member. Invite the bot first with `/invite @bgagent`, or submit from a public channel or DM.' };
      }
      // Anything else (ratelimited, internal_error, fatal_error, network blip) is
      // likely transient — fail open and let slack-notify surface any real delivery
      // failure downstream. Blocking task submission on a 30-second Slack blip is
      // a worse UX than creating a task that notifies late.
      logger.warn('Channel access check: transient/unknown Slack error, failing open', {
        error: result.error,
        channel_id: channelId,
      });
      return { ok: true };
    }

    if (result.channel?.is_private && !result.channel?.is_member) {
      return { ok: false, error: ':lock: This is a private channel and the bot is not a member. Invite the bot first with `/invite @bgagent`, or submit from a public channel or DM.' };
    }

    return { ok: true };
  } catch (err) {
    // Network-level failure — treat the same as a transient Slack error.
    logger.warn('Channel access check network failure, failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }
}

// ─── Slack File Extraction ───────────────────────────────────────────────────

/** Max number of file attachments per Slack message. */
const SLACK_FILE_MAX_COUNT = 10;

/** MIME types supported for attachments (must match validation.ts — PNG/JPEG only). */
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
const SUPPORTED_FILE_MIMES = new Set([
  'text/plain', 'text/csv', 'text/markdown', 'application/json',
  'application/pdf', 'text/x-log',
]);

/**
 * Download Slack file attachments and convert them to inline Attachment objects.
 * Returns null if validation fails (reply already sent). Returns an empty array
 * if no files are attached.
 *
 * Implements atomic failure semantics: if ANY file fails validation or download,
 * the entire submission is rejected with a descriptive error listing all failures.
 */
async function extractSlackFileAttachments(
  event: MentionEvent,
  reply: ReplyFn,
): Promise<Attachment[] | null> {
  const files = event.files;
  if (!files || files.length === 0) return [];

  if (files.length > SLACK_FILE_MAX_COUNT) {
    await reply(`:x: Task not created. Too many attachments (${files.length}, max ${SLACK_FILE_MAX_COUNT}).`);
    return null;
  }

  const errors: string[] = [];
  const attachments: Attachment[] = [];

  const botToken = await getBotToken(event.team_id);
  if (!botToken) {
    await reply(':x: Task not created. Cannot download attachments (bot token not found).');
    return null;
  }

  // The bytes accepted so far, and why a file of `bytes` more is refused, if it is.
  // The files reach createTaskCore as inline attachments, so the limits are those
  // of validateAttachments for inline data: 500 KB per file and 3 MB per task.
  let totalBytes = 0;
  const sizeError = (bytes: number): string | undefined => {
    if (bytes > MAX_INLINE_ATTACHMENT_SIZE_BYTES) {
      return `too large, ${Math.ceil(bytes / 1024)} KB > ${MAX_INLINE_ATTACHMENT_SIZE_BYTES / 1024} KB limit`;
    }
    if (totalBytes + bytes > MAX_TOTAL_INLINE_SIZE_BYTES) {
      return `more than ${MAX_TOTAL_INLINE_SIZE_BYTES / (1024 * 1024)} MB of attachments in total`;
    }
    return undefined;
  };

  for (const file of files) {
    // Validate the size Slack declares, before anything is downloaded.
    const declaredSizeError = sizeError(file.size);
    if (declaredSizeError) {
      errors.push(`\`${file.name}\` (${declaredSizeError})`);
      continue;
    }

    // Validate MIME type
    const mime = file.mimetype.toLowerCase();
    const isImage = SUPPORTED_IMAGE_MIMES.has(mime);
    const isFile = SUPPORTED_FILE_MIMES.has(mime);
    if (!isImage && !isFile) {
      errors.push(`\`${file.name}\` has unsupported type \`${mime}\``);
      continue;
    }

    // Validate the download URL points to a legitimate Slack domain before
    // sending the bot token — prevents SSRF and token exfiltration via crafted events.
    if (!isSlackFileUrl(file.url_private_download)) {
      errors.push(`\`${file.name}\` (invalid download URL — not a Slack domain)`);
      continue;
    }

    // Download the file from Slack CDN using the bot token
    try {
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        errors.push(`\`${file.name}\` (download failed: HTTP ${response.status})`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Post-download size validation: Slack's declared file.size may differ
      // from the actual download (e.g., server-side processing, bug, or manipulation).
      const downloadedSizeError = sizeError(buffer.length);
      if (downloadedSizeError) {
        errors.push(`\`${file.name}\` (${downloadedSizeError})`);
        continue;
      }
      totalBytes += buffer.length;

      attachments.push({
        type: isImage ? 'image' : 'file',
        content_type: mime,
        filename: file.name,
        data: buffer.toString('base64'),
      });
    } catch (err) {
      logger.error('Failed to download Slack file', {
        filename: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push(`\`${file.name}\` (download failed)`);
    }
  }

  // Atomic failure: if any file failed, reject the entire submission
  if (errors.length > 0) {
    const errorList = errors.length === 1
      ? errors[0]
      : `${errors.length} attachment errors: ${errors.join(', ')}`;
    await reply(`:x: Task not created. ${errorList}. Fix or remove these files and try again.`);
    return null;
  }

  return attachments;
}

/** Validate that a URL points to a legitimate Slack file domain. */
function isSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'files.slack.com' || parsed.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function lookupPlatformUser(teamId: string, userId: string): Promise<string | null> {
  const key = `${teamId}#${userId}`;
  logger.info('Looking up platform user', { slack_identity: key, table: USER_MAPPING_TABLE });
  const result = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: key },
  }));

  if (!result.Item) {
    logger.warn('No user mapping found', { slack_identity: key });
    return null;
  }
  if (result.Item.status === 'pending') {
    logger.warn('User mapping is pending', { slack_identity: key });
    return null;
  }
  logger.info('Found platform user', { slack_identity: key, platform_user_id: result.Item.platform_user_id });
  return (result.Item.platform_user_id as string) ?? null;
}

/**
 * Resolve a channel's default repo from the onboarding table
 * (`bgagent slack onboard-channel`). Returns the mapped `owner/repo` when an
 * active mapping exists, else null. Fails open (returns null) on any error so a
 * lookup blip degrades to the "please include a repo" path rather than a 500.
 */
async function lookupChannelDefaultRepo(teamId: string, channelId: string): Promise<string | null> {
  if (!CHANNEL_MAPPING_TABLE) return null;
  const key = `${teamId}#${channelId}`;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: CHANNEL_MAPPING_TABLE,
      Key: { channel_id: key },
    }));
    if (!result.Item || result.Item.status !== 'active') return null;
    return (result.Item.repo as string) ?? null;
  } catch (err) {
    logger.warn('Channel default repo lookup failed, falling back to explicit-repo path', {
      channel_id: key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- fail-open is intentional; absent default → explicit-repo error path
  }
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
  logger.info('Posting to Slack response_url', {
    response_url: responseUrl.substring(0, RESPONSE_URL_LOG_PREFIX_LEN),
    text_length: text.length,
  });
  try {
    const response = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('Failed to post to Slack response_url', {
        status: response.status,
        response_url: responseUrl.substring(0, RESPONSE_URL_LOG_PREFIX_LEN),
        body,
      });
    } else {
      logger.info('Slack response_url post succeeded', { status: response.status });
    }
  } catch (err) {
    logger.warn('Error posting to Slack response_url', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Swap one reaction for another on the mention. A payload from an events
 * handler that predates mention_message_ts names only the thread.
 */
async function swapReaction(event: MentionEvent, remove: string, add: string): Promise<void> {
  const messageTs = event.mention_message_ts ?? event.mention_thread_ts;
  if (!messageTs) return;
  const botToken = await getBotToken(event.team_id);
  if (!botToken) return;
  await slackFetch(botToken, 'reactions.remove', { channel: event.channel_id, timestamp: messageTs, name: remove });
  await slackFetch(botToken, 'reactions.add', { channel: event.channel_id, timestamp: messageTs, name: add });
}
