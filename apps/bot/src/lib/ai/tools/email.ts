import { AgentMailClient } from 'agentmail';
import { tool } from 'ai';
import { z } from 'zod';
import { redactionNote, redactSecrets } from '@/lib/email/redact';
import { errorMessage } from '@/lib/utils/error';

// Email runs on the host (not the sandbox): AgentMail is a plain HTTP API, so a
// first-class tool is more reliable and visible than asking the model to write
// sandbox code. The API key lives on the host only.
//
// Everything READ out of the inbox goes through redactSecrets first, so login
// links and one-time codes never enter the model's context at all. See
// lib/email/redact.ts for why that is done here rather than by asking the model
// to be careful, or by checking who is asking.

// How much of one email body to hand back. Long enough for a real message,
// short enough that a mailing list can't flood the turn's context.
const BODY_MAX_CHARS = 12_000;

function clampBody(text: string): string {
  return text.length > BODY_MAX_CHARS
    ? `${text.slice(0, BODY_MAX_CHARS)}\n…(truncated)`
    : text;
}

const recipientsSchema = z
  .union([z.string(), z.array(z.string())])
  .describe('Recipient email address(es).');

async function resolveInboxId(
  client: AgentMailClient,
  inboxId?: string
): Promise<string> {
  if (inboxId) {
    return inboxId;
  }
  const { inboxes } = await client.inboxes.list();
  const first = inboxes.at(0);
  if (!first) {
    throw new Error(
      'No AgentMail inbox exists yet. Create one in AgentMail first.'
    );
  }
  return first.inboxId;
}

export function sendEmailTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      "Send an email from kyto's own inbox (via AgentMail). Use for sending messages, notifications, or replies to external email addresses.",
    inputSchema: z.object({
      to: recipientsSchema,
      subject: z.string().min(1).max(998),
      text: z.string().min(1).describe('Plain-text body of the email.'),
      cc: recipientsSchema.optional(),
      bcc: recipientsSchema.optional(),
      html: z.string().optional().describe('Optional HTML body.'),
      inboxId: z
        .string()
        .optional()
        .describe('Sending inbox id. Defaults to the first inbox.'),
    }),
    execute: async ({ bcc, cc, html, inboxId, subject, text, to }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const result = await client.inboxes.messages.send(resolvedInbox, {
          to,
          subject,
          text,
          ...(html ? { html } : {}),
          ...(cc ? { cc } : {}),
          ...(bcc ? { bcc } : {}),
        });
        const recipients = Array.isArray(to) ? to.join(', ') : to;
        return {
          success: true,
          messageId: result.messageId,
          summary: `Sent email "${subject}" to ${recipients}.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to send email: ${errorMessage(error)}`,
        };
      }
    },
  });
}

export function checkInboxTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      'List recent messages in kyto\'s own email inbox (via AgentMail). This gives you each message\'s sender, subject and a short preview — call readEmail with a message id to get the actual body. Set full:true to fetch the bodies of everything listed in one go, which is usually what someone means by "read my latest email".',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
      full: z
        .boolean()
        .optional()
        .describe(
          'Fetch the full body of every listed message, not just the preview. Keep limit small when using this.'
        ),
      inboxId: z
        .string()
        .optional()
        .describe('Inbox id to read. Defaults to the first inbox.'),
    }),
    execute: async ({ full, inboxId, limit }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const { messages } = await client.inboxes.messages.list(resolvedInbox, {
          limit,
        });
        let redactions = 0;
        const rendered = await Promise.all(
          messages.map(async (message) => {
            const preview = redactSecrets(message.preview);
            redactions += preview.redactions;
            const base = {
              from: message.from,
              id: message.messageId,
              preview: preview.text,
              subject: redactSecrets(message.subject).text,
              // AgentMail hands back a raw JS Date here. A tool result must be
              // JSON-primitive: streamText re-validates the WHOLE accumulated
              // history against jsonValueSchema on every step, and that schema
              // rejects a Date outright — so leaving it raw makes the step AFTER
              // checkInbox fail with "malformed prompt" every single time.
              timestamp: message.timestamp.toISOString(),
            };
            if (!full) {
              return base;
            }
            const body = await readBody({
              client,
              inboxId: resolvedInbox,
              messageId: message.messageId,
            }).catch(() => null);
            if (body) {
              redactions += body.redactions;
            }
            return { ...base, body: body?.text };
          })
        );
        return {
          messageCount: rendered.length,
          messages: rendered,
          note: redactionNote(redactions),
          success: true,
          summary: `Found ${rendered.length} message${rendered.length === 1 ? '' : 's'} in the inbox.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to read inbox: ${errorMessage(error)}`,
        };
      }
    },
  });
}

/** Fetch and redact one message's body. AgentMail's list only has previews. */
async function readBody({
  client,
  inboxId,
  messageId,
}: {
  client: AgentMailClient;
  inboxId: string;
  messageId: string;
}): Promise<{ redactions: number; text: string }> {
  const message = await client.inboxes.messages.get(inboxId, messageId);
  // `text` is the whole message; `extractedText` is just the new content of a
  // reply, without the quoted history. Prefer the full text so kyto can answer
  // questions about the thread, and fall back through the alternatives.
  const raw = message.text || message.extractedText || message.preview || '';
  const { redactions, text } = redactSecrets(raw);
  return { redactions, text: clampBody(text) };
}

export function readEmailTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      "Read the full body of one message in kyto's inbox, by the message id from checkInbox. Use this whenever someone asks what an email actually says — the preview from checkInbox is only the first line or so.",
    inputSchema: z.object({
      messageId: z.string().min(1).describe('Message id from checkInbox.'),
      inboxId: z
        .string()
        .optional()
        .describe('Inbox id the message belongs to. Defaults to the first.'),
    }),
    execute: async ({ inboxId, messageId }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const message = await client.inboxes.messages.get(
          resolvedInbox,
          messageId
        );
        const body = redactSecrets(
          message.text || message.extractedText || message.preview || ''
        );
        const subject = redactSecrets(message.subject);
        return {
          attachments: message.attachments?.map(
            (attachment) => attachment.filename
          ),
          body: clampBody(body.text),
          cc: message.cc,
          from: message.from,
          id: message.messageId,
          note: redactionNote(body.redactions + subject.redactions),
          subject: subject.text,
          success: true,
          // JSON-primitive only — a raw Date here breaks the next step's prompt
          // validation (see checkInbox above).
          timestamp: message.timestamp.toISOString(),
          to: message.to,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to read message ${messageId}: ${errorMessage(error)}`,
        };
      }
    },
  });
}

export function replyEmailTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      "Reply to a message in kyto's email inbox (via AgentMail). Use the message id from checkInbox.",
    inputSchema: z.object({
      messageId: z.string().min(1),
      text: z.string().min(1).describe('Plain-text reply body.'),
      html: z.string().optional(),
      inboxId: z
        .string()
        .optional()
        .describe('Inbox id the message belongs to. Defaults to the first.'),
    }),
    execute: async ({ html, inboxId, messageId, text }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const result = await client.inboxes.messages.reply(
          resolvedInbox,
          messageId,
          { text, ...(html ? { html } : {}) }
        );
        return {
          success: true,
          messageId: result.messageId,
          summary: `Replied to email ${messageId}.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to reply: ${errorMessage(error)}`,
        };
      }
    },
  });
}
