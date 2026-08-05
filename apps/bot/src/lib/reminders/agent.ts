import {
  type SandboxContext,
  streamAttempt,
  subagentAttempt,
  subagentSystemPrompt,
} from '@repo/ai';
import type { Reminder } from '@repo/db/queries';
import { env } from '@/env';
import type { Message, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import { bot } from '@/lib/chat';
import { brokerableGithubToken } from '@/lib/github/token';
import logger from '@/lib/logger';
import { createSandbox } from '@/lib/sandbox/provider';
import { threadSandboxStore, withThreadSandbox } from '@/lib/sandbox/store';
import {
  registerProxyToken,
  revokeProxyToken,
  slackHelperInstall,
  slackProxyEnv,
} from '@/lib/slack-proxy';

// An agent reminder runs the SAME multi-step tool loop as a real turn, but
// headless: nothing is streamed to Slack, and its final text becomes the
// reminder's message. It is pinned to the cheap subagent model rather than the
// turn router, so an unattended job's cost stays predictable no matter what the
// reminder text asks for.
const RECURRING_JOB_NOTE = `

<recurring_job>
You are running as a recurring background job, not a live chat turn: there is no chat history, nobody to ask a follow-up question, and no memory of previous runs.

NOBODY IS WATCHING THIS RUN. Do not ask questions, do not offer choices, and do not wait for confirmation — there is nobody there to answer, and a question posted here just reads as the job failing. If something needs doing and you are allowed to do it, DO IT, then say what you did. If you genuinely cannot proceed, say what blocked you and what you need — as a statement, not a question.

ALWAYS leave a report. Even a run where nothing happened should say so ("checked X, nothing new since the last run") — that is the useful outcome, not silence. Your final reply is posted verbatim as the message, so write it as the message: no preamble, no meta-commentary about being a scheduled job.

Slack search (searchSlack) will not work here, as it needs a live user interaction to authorize it; prefer readConversationHistory, searchWeb, or bash.
</recurring_job>`;

// Asked of the same model, tools off, when a run did work but wrote nothing.
const REPORT_NUDGE =
  'You ran the job above but never wrote the message. Write it now, from what you just did: what you checked, what you found, and anything you changed. You have NO TOOLS for this message — that is deliberate, not an error, so do not try to call one or comment on their absence. Write only the message that should be posted.';

/** The reminder's owner, as the author of the synthetic message driving it. */
function syntheticMessage(reminder: Reminder, threadId: string): Message {
  return {
    attachments: [],
    author: { userId: reminder.userId, userName: reminder.userId },
    id: `reminder-${reminder.id}-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: reminder.text,
    threadId,
  };
}

/**
 * Run an agent reminder and return the text it decided to post.
 *
 * It reuses the persistent sandbox of the thread it was created in (holding
 * that thread's lock), so it can read files kyto wrote when the reminder was
 * set up. Without a `threadId` it gets its own throwaway sandbox.
 */
export async function runReminderAgent(reminder: Reminder): Promise<string> {
  const attempt = subagentAttempt;
  if (!attempt) {
    throw new Error(
      'No model is configured for agent reminders (the subagent roster is empty).'
    );
  }
  const run = () => runAgent(reminder, attempt);
  return reminder.threadId
    ? await withThreadSandbox(reminder.threadId, run)
    : await run();
}

/**
 * Second chance at the message: same model, no tools, "write the report you
 * skipped". Best-effort — a failure here just falls through to the caller's
 * placeholder, which is still better than the run being silent.
 */
async function synthesizeReport({
  attempt,
  hints,
  reminder,
}: {
  attempt: NonNullable<typeof subagentAttempt>;
  hints: Awaited<ReturnType<typeof requestHints>>;
  reminder: Reminder;
}): Promise<string | undefined> {
  try {
    const result = streamAttempt({
      attempt,
      holder: {},
      prompt: `${reminder.text}\n\n${REPORT_NUDGE}`,
      system: `${subagentSystemPrompt({ hints })}${RECURRING_JOB_NOTE}`,
      tools: {},
    });
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
      }
    }
    return text.trim() || undefined;
  } catch (error) {
    logger.warn(
      { err: error, reminderId: reminder.id },
      '[reminders] report nudge failed'
    );
    return;
  }
}

async function runAgent(
  reminder: Reminder,
  attempt: NonNullable<typeof subagentAttempt>
): Promise<string> {
  // Where the job's tools act, and where an agent reminder without a channel
  // posts: the thread it was created in, else the user's DM.
  const thread: ThreadHandle = reminder.threadId
    ? bot.thread(reminder.threadId)
    : await bot.openDM(reminder.userId);
  const message = syntheticMessage(reminder, thread.id);

  // A fresh proxy token for this fire (the creating turn's was revoked long
  // ago), so the job's bash/slackScript tools can read Slack.
  const secret = env.SITES_ENABLED ? registerProxyToken() : undefined;
  const sandboxSession = await createSandbox(env, {
    bootstrapCommand: secret ? slackHelperInstall() : undefined,
    baseEnv: secret ? slackProxyEnv(secret, env.SITES_PUBLIC_HOST) : {},
    githubToken: await brokerableGithubToken(),
    logger,
    // Sharing the thread's sandbox is the whole point: the job can use what the
    // model built earlier. Jobs without a thread get an unremembered sandbox.
    sessionId: reminder.threadId ?? undefined,
    store: reminder.threadId ? threadSandboxStore : undefined,
  });
  const sandboxContext: SandboxContext = {
    session: sandboxSession,
    sessionWorkDir: sandboxSession.workDir,
  };

  const { buildTools } = await import('@/lib/ai/toolset');
  let close: (() => Promise<void>) | undefined;
  try {
    const hints = await requestHints({ message, thread });
    const built = await buildTools({
      bot,
      getSandboxContext: () => sandboxContext,
      message,
      thread,
    });
    close = built.close;

    const result = streamAttempt({
      activeTools: built.activeTools,
      attempt,
      holder: {},
      prompt: reminder.text,
      system: `${subagentSystemPrompt({ hints })}${RECURRING_JOB_NOTE}`,
      tools: built.tools,
    });

    let text = '';
    let toolCalls = 0;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (part.type === 'tool-call') {
        toolCalls += 1;
      }
    }
    const reply = text.trim();
    if (reply) {
      return reply;
    }
    if (toolCalls > 0) {
      // The job did real work and then said nothing, which used to post
      // "(Completed scheduled actions with no additional message.)" — a line
      // that tells its reader precisely nothing about what happened. Ask the
      // same model to write the report it skipped, tools off so no side effect
      // can fire a second time. Same nudge the live agent loop uses.
      const nudged = await synthesizeReport({ attempt, hints, reminder });
      if (nudged) {
        return nudged;
      }
      logger.warn(
        { reminderId: reminder.id },
        '[reminders] agent job did work but produced no report, even after a nudge'
      );
      return '_(Ran the scheduled job — it completed its actions but did not write a report.)_';
    }
    throw new Error('Agent reminder produced an empty response.');
  } finally {
    revokeProxyToken(secret);
    await close?.().catch(() => undefined);
    await sandboxSession.destroy().catch(() => undefined);
  }
}
