import nodePath from 'node:path/posix';
import {
  type ImageInput,
  type SandboxContext,
  SKIP_TOOL_NAME,
  subagentAttempt,
} from '@repo/ai';
import { listMcpServers } from '@repo/db/queries';
import { type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot, Message, ThreadHandle } from '@/harness';
import { buildMcpTools } from '@/lib/ai/mcp';
import logger from '@/lib/logger';
import { askQuestionTool } from './tools/ask-question';
import { backgroundProcessTools } from './tools/background';
import { browserTool } from './tools/browser';
import {
  canvasDeleteTool,
  canvasListTool,
  canvasReadTool,
  canvasWriteTool,
} from './tools/canvas';
import { createChannelTool, setChannelTopicTool } from './tools/channels';
import { codeModeTool } from './tools/code-mode';
import {
  deploySiteTool,
  listSitesTool,
  removeSiteTool,
} from './tools/deploy-site';
import {
  checkInboxTool,
  readEmailTool,
  replyEmailTool,
  sendEmailTool,
} from './tools/email';
import { deleteFileTool, fileStatTool } from './tools/files';
import { focusModeTool } from './tools/focus';
import { generateImageTool } from './tools/generate-image';
import { getChannelInfoTool } from './tools/get-channel-info';
import { getFileTool } from './tools/get-file';
import { getUserTool } from './tools/get-user';
import { ghTool, githubAccessTool } from './tools/gh';
import { joinThreadTool } from './tools/join-thread';
import { leaveThreadTool } from './tools/leave-thread';
import { listThreadsTool } from './tools/list-threads';
import {
  deleteMemoryTool,
  editMemoryTool,
  fetchMemoryTool,
  saveMemoryTool,
} from './tools/memory';
import { mermaidTool } from './tools/mermaid';
import {
  bookmarkLinkTool,
  pinMessageTool,
  unpinMessageTool,
} from './tools/pins';
import { pollTool } from './tools/poll';
import { postMessageTool } from './tools/post-message';
import { reactTool, unreactTool } from './tools/react';
import { readConversationHistoryTool } from './tools/read-conversation-history';
import {
  cancelReminderTool,
  editReminderTool,
  listRemindersTool,
  pauseReminderTool,
  resumeReminderTool,
  scheduleRecurringReminderTool,
} from './tools/reminders';
import {
  bashTool,
  editFileTool,
  readFileTool,
  writeFileTool,
} from './tools/sandbox';
import { scheduleReminderTool } from './tools/schedule-reminder';
import { searchSlackTool } from './tools/search-slack';
import { searchWebTool } from './tools/search-web';
import { editAsUserTool, sendAsUserTool } from './tools/send-as-user';
import { skipTool } from './tools/skip';
import { slackDocsTool } from './tools/slack-docs';
import { slackScriptTool } from './tools/slack-script';
import { runSubagentTool } from './tools/subagent';
import { summarizeThreadTool } from './tools/summarize-thread';
import { textToSpeechTool } from './tools/text-to-speech';
import { uploadFileTool } from './tools/upload-file';
import { fetchUrlTool, getPermalinkTool } from './tools/url';
import { viewImageTool } from './tools/view-image';
import { waitTool } from './tools/wait';

export interface BuiltTools {
  /** Live view of the tool names currently exposed to the model. */
  activeTools: () => string[];
  /** Close per-turn resources (MCP connections). */
  close: () => Promise<void>;
  /**
   * Drain images the model asked to view (via viewImage) since the last call.
   * The agent loop injects them as a user message so the model actually sees
   * them on its next step.
   */
  drainImages: () => ImageInput[];
  tools: ToolSet;
}

/**
 * Build the turn's toolset. Core tools are always visible; uncommon tools
 * (browser, email, rare Slack ops) and the user's MCP tools are DEFERRED —
 * registered but hidden from the model until it calls `loadTools`, so their
 * schemas don't ride along in every prompt. `activeTools` feeds streamText's
 * prepareStep, which is what actually gates visibility per step.
 */
export async function buildTools({
  bot,
  extendAttemptDeadline,
  getSandboxContext,
  message,
  thread,
}: {
  bot: KytoBot;
  /**
   * Push the running attempt's watchdog out. The `wait` tool calls it so a long
   * deliberate pause is never mistaken for a stalled attempt. Absent for callers
   * with no watchdog of their own (the subagent, reminders).
   */
  extendAttemptDeadline?: (extraMs: number) => void;
  getSandboxContext: () => SandboxContext;
  message: Message;
  thread: ThreadHandle;
}): Promise<BuiltTools> {
  const authorUserId = message.author.userId;
  const isOwner =
    Boolean(env.OWNER_USER_ID) && authorUserId === env.OWNER_USER_ID;
  const canActAsOwner = Boolean(env.SLACK_USER_TOKEN) && isOwner;
  const agentMailKey = env.AGENTMAIL_API_KEY;

  // Images the model loaded with viewImage this turn, waiting to be injected
  // into the conversation as a user message on the next step (drainImages).
  const pendingImages: ImageInput[] = [];

  // Background-process trio shares one in-turn handle map; built before `core`
  // so the bash tool can share it and auto-background a command that runs long.
  // It gets the same `github` principal as the other shells: a detached command
  // outlives the turn, so its GitHub write has to be authorized at START time.
  const background = backgroundProcessTools({
    getSandboxContext,
    github: { isOwner, threadId: thread.id, userId: authorUserId },
  });

  const core: ToolSet = {
    bash: bashTool({
      background,
      getSandboxContext,
      github: { isOwner, threadId: thread.id, userId: authorUserId },
    }),
    codeMode: codeModeTool({
      getSandboxContext,
      github: { isOwner, threadId: thread.id, userId: authorUserId },
    }),
    readFile: readFileTool({ getSandboxContext }),
    writeFile: writeFileTool({ getSandboxContext }),
    editFile: editFileTool({ getSandboxContext }),
    deleteFile: deleteFileTool({ getSandboxContext }),
    fileStat: fileStatTool({ getSandboxContext }),
    wait: waitTool({ extendAttemptDeadline, getSandboxContext }),
    react: reactTool({ bot }),
    unreact: unreactTool({ bot }),
    getUser: getUserTool(),
    postMessage: postMessageTool({
      authorUserId,
      bot,
      currentThreadId: thread.id,
      extendAttemptDeadline,
      isOwner,
    }),
    getFile: getFileTool({ getSandboxContext }),
    viewImage: viewImageTool({
      getSandboxContext,
      pushImage: (image) => pendingImages.push(image),
    }),
    joinThread: joinThreadTool({ thread }),
    leaveThread: leaveThreadTool({ thread }),
    focusMode: focusModeTool({ thread }),
    canvasRead: canvasReadTool(),
    canvasWrite: canvasWriteTool({ thread }),
    canvasList: canvasListTool({ thread }),
    getPermalink: getPermalinkTool({ thread }),
    fetchUrl: fetchUrlTool(),
    deploySite: deploySiteTool({
      getSandboxContext,
      isOwner,
      userId: authorUserId,
    }),
    listSites: listSitesTool(),
    removeSite: removeSiteTool({ isOwner, userId: authorUserId }),
    // Keyed off the constant: the stop condition that makes a skip terminal
    // matches on this exact name (see streamAttempt).
    [SKIP_TOOL_NAME]: skipTool({ threadId: thread.id }),
    saveMemory: saveMemoryTool({ authorUserId, isOwner }),
    fetchMemory: fetchMemoryTool({ authorUserId, isOwner }),
    editMemory: editMemoryTool({ authorUserId, isOwner }),
    deleteMemory: deleteMemoryTool({ authorUserId, isOwner }),
    listThreads: listThreadsTool({ currentThreadId: thread.id }),
    readConversationHistory: readConversationHistoryTool({
      currentThreadId: thread.id,
    }),
    getChannelInfo: getChannelInfoTool({ currentThreadId: thread.id }),
    scheduleReminder: scheduleReminderTool({ message }),
    scheduleRecurringReminder: scheduleRecurringReminderTool({ message }),
    listReminders: listRemindersTool({ message }),
    editReminder: editReminderTool({ message }),
    cancelReminder: cancelReminderTool({ message }),
    pauseReminder: pauseReminderTool({ message }),
    resumeReminder: resumeReminderTool({ message }),
    searchSlack: searchSlackTool({ message }),
    searchWeb: searchWebTool({ apiKey: env.EXA_API_KEY }),
    summarizeThread: summarizeThreadTool({ bot, threadId: thread.id }),
    generateImage: generateImageTool({
      getSandboxContext,
      upload: async ({ bytes, mediaType, index, total }) => {
        const filename = `kyto-image-${index + 1}.${mediaType.split('/').at(1) ?? 'png'}`;
        await thread.post({
          files: [{ data: bytes, filename }],
          markdown:
            total > 1 ? `Generated image ${index + 1}` : 'Generated image',
        });
      },
    }),
    uploadFile: uploadFileTool({
      upload: async ({ filename, path, title }) => {
        const sandboxContext = getSandboxContext();
        const { session, sessionWorkDir } = sandboxContext;
        const sandboxPath = nodePath.normalize(
          path.startsWith('/') ? path : nodePath.join(sessionWorkDir, path)
        );
        if (
          sandboxPath !== sessionWorkDir &&
          !sandboxPath.startsWith(`${sessionWorkDir}/`)
        ) {
          throw new Error(
            'uploadFile can only upload files from the workspace.'
          );
        }
        const bytes = await session.readBinaryFile({ path: sandboxPath });
        if (!bytes) {
          throw new Error(`Could not find file: ${path}`);
        }
        const resolvedFilename =
          filename ?? nodePath.basename(sandboxPath) ?? 'artifact';
        await thread.post({
          files: [{ data: bytes, filename: resolvedFilename }],
          markdown: title ?? resolvedFilename,
        });
        return { filename: resolvedFilename, uploaded: true };
      },
    }),
  };

  const ttsAvailable = Boolean(
    env.HACKCLUB_REPLICATE_API_KEY || env.GEMINI_API_KEY
  );

  // Deferred: registered but hidden until loadTools names them.
  const deferred: Record<string, { summary: string; tool: Tool }> = {
    browser: {
      summary: 'drive a real Chromium browser (screenshots, clicks, scraping)',
      tool: browserTool({ getSandboxContext }),
    },
    runBackgroundProcess: {
      summary: 'start a long-running shell command in the background',
      tool: background.runBackgroundProcess,
    },
    getProcessOutput: {
      summary: 'read output / status of a background process',
      tool: background.getProcessOutput,
    },
    killProcess: {
      summary: 'kill a background process',
      tool: background.killProcess,
    },
    canvasDelete: {
      summary: 'delete a Slack canvas',
      tool: canvasDeleteTool(),
    },
    slackDocs: {
      summary:
        'reference notes: Block Kit blocks/limits, canvas markdown (checkboxes), search modifiers',
      tool: slackDocsTool(),
    },
    createChannel: {
      summary: 'create a Slack channel',
      tool: createChannelTool(),
    },
    setChannelTopic: {
      summary: 'set a channel topic',
      tool: setChannelTopicTool({ thread }),
    },
    bookmarkLink: {
      summary: 'add a bookmark to a channel',
      tool: bookmarkLinkTool({ thread }),
    },
    pinMessage: {
      summary: 'pin a message',
      tool: pinMessageTool({ authorUserId, thread }),
    },
    unpinMessage: {
      summary: 'unpin a message',
      tool: unpinMessageTool({ authorUserId, thread }),
    },
    poll: {
      summary: 'post an interactive poll',
      tool: pollTool({ thread }),
    },
    askQuestion: {
      summary:
        'ask named people a multiple-choice question in this thread and wait for their answer',
      tool: askQuestionTool({ extendAttemptDeadline, thread }),
    },
    mermaid: {
      summary: 'render a mermaid diagram as an image',
      tool: mermaidTool({ thread }),
    },
    ...(env.GH_TOKEN
      ? {
          gh: {
            summary: 'run a GitHub CLI (`gh`) command in the sandbox',
            tool: ghTool({
              getSandboxContext,
              isOwner,
              threadId: thread.id,
              userId: authorUserId,
            }),
          },
          githubAccess: {
            summary:
              'see who a GitHub repo belongs to, or change who may write to it',
            tool: githubAccessTool({ isOwner, userId: authorUserId }),
          },
        }
      : {}),
    ...(env.SITES_ENABLED
      ? {
          slackScript: {
            summary:
              'run a read-only bash script against the Slack API (aggregate queries)',
            tool: slackScriptTool({ getSandboxContext }),
          },
        }
      : {}),
    ...(subagentAttempt
      ? (() => {
          const subagent = runSubagentTool({
            getSandboxContext,
            bot,
            message,
            thread,
          });
          return {
            runSubagent: {
              summary:
                'delegate a task to a headless subagent that returns a report',
              tool: subagent.runSubagent,
            },
            checkSubagent: {
              summary:
                'check / collect a background subagent started with runSubagent',
              tool: subagent.checkSubagent,
            },
          };
        })()
      : {}),
    ...(ttsAvailable
      ? {
          textToSpeech: {
            summary: 'convert text to spoken audio and upload it to the thread',
            tool: textToSpeechTool({
              upload: async ({ data, filename }) => {
                await thread.post({
                  files: [{ data: new Uint8Array(data), filename }],
                  markdown: 'Generated audio',
                });
              },
            }),
          },
        }
      : {}),
    ...(agentMailKey
      ? {
          sendEmail: {
            summary: 'send an email from forkie’s inbox',
            tool: sendEmailTool({ apiKey: agentMailKey }),
          },
          checkInbox: {
            summary: 'check forkie’s email inbox',
            tool: checkInboxTool({ apiKey: agentMailKey }),
          },
          readEmail: {
            summary: 'read one email in full',
            tool: readEmailTool({ apiKey: agentMailKey }),
          },
          replyEmail: {
            summary: 'reply to an email thread',
            tool: replyEmailTool({ apiKey: agentMailKey }),
          },
        }
      : {}),
    ...(canActAsOwner
      ? {
          sendAsUser: {
            summary: 'send a Slack message AS the owner',
            tool: sendAsUserTool({
              authorUserId,
              extendAttemptDeadline,
              thread,
            }),
          },
          editAsUser: {
            summary: 'edit one of the owner’s Slack messages',
            tool: editAsUserTool({
              authorUserId,
              extendAttemptDeadline,
              thread,
            }),
          },
        }
      : {}),
  };

  // The requesting user's remote MCP servers (added via kyto's App Home tab),
  // also deferred behind loadTools.
  const servers = await listMcpServers(authorUserId).catch((error: unknown) => {
    logger.warn({ err: error, userId: authorUserId }, '[mcp] listing failed');
    return [];
  });
  const mcp = await buildMcpTools({ logger, servers });
  for (const [name, mcpTool] of Object.entries(mcp.tools)) {
    deferred[name] = {
      summary: `MCP tool (${name})`,
      tool: mcpTool,
    };
  }

  const catalog = Object.entries(deferred)
    .map(([name, entry]) => `- ${name}: ${entry.summary}`)
    .join('\n');
  const active = new Set(Object.keys(core));
  active.add('loadTools');

  // Deferral is a trade: a deferred tool's schema stays out of the cached
  // prefix, but reaching it costs an extra round trip (loadTools, then the call
  // itself) — and the round trip is billed at full price while the schema would
  // have been a cached read. Which way that trade lands is an empirical
  // question nobody has data for, so every turn now records what was loaded,
  // what was actually CALLED, and what was loaded and then never used. Read it
  // back with `journalctl -u kyto.service | grep '\[tools\] turn summary'`:
  // a deferred tool that is always loaded and always used should be promoted
  // into `core`; a core tool that never appears in `coreUsed` should be
  // deferred.
  const usage = new Map<string, number>();
  const loadedNames = new Set<string>();
  let loadToolsCalls = 0;
  const trackUse = <T extends Tool>(name: string, entry: T): T => {
    const original = entry.execute;
    if (typeof original !== 'function') {
      return entry;
    }
    return {
      ...entry,
      execute: (input: never, options: never) => {
        usage.set(name, (usage.get(name) ?? 0) + 1);
        return original(input, options);
      },
    } as T;
  };

  const loadTools = tool({
    description: `Load additional tools by name before using them (their schemas stay out of the prompt until needed). Available:\n${catalog || '- (none)'}`,
    inputSchema: z.object({
      tools: z
        .array(z.string())
        .min(1)
        .describe('Deferred tool names to load.'),
    }),
    execute: ({ tools: names }) => {
      loadToolsCalls += 1;
      const loaded: string[] = [];
      const unknown: string[] = [];
      for (const name of names) {
        if (deferred[name]) {
          active.add(name);
          loaded.push(name);
          loadedNames.add(name);
        } else {
          unknown.push(name);
        }
      }
      return Promise.resolve({
        loaded,
        summary: loaded.length
          ? `Loaded: ${loaded.join(', ')}. They are available as tools from the next step.`
          : 'No matching tools.',
        unknown,
      });
    },
  });

  const tools: ToolSet = {
    ...Object.fromEntries(
      Object.entries(core).map(([name, entry]) => [name, trackUse(name, entry)])
    ),
    loadTools,
    ...Object.fromEntries(
      Object.entries(deferred).map(([name, entry]) => [
        name,
        trackUse(name, entry.tool),
      ])
    ),
  };

  const coreNames = new Set(Object.keys(core));

  return {
    activeTools: () => [...active],
    close: async () => {
      const called = [...usage.keys()];
      logger.info(
        {
          coreUsed: called.filter((name) => coreNames.has(name)),
          loadToolsCalls,
          loaded: [...loadedNames],
          // Loaded and then never called: pure waste — a round trip and a schema
          // paid for nothing. A name that shows up here repeatedly means the
          // catalog description is misleading the model.
          loadedUnused: [...loadedNames].filter((name) => !usage.has(name)),
          loadedUsed: [...loadedNames].filter((name) => usage.has(name)),
          userId: authorUserId,
        },
        '[tools] turn summary'
      );
      await mcp.close();
    },
    drainImages: () => pendingImages.splice(0),
    tools,
  };
}
