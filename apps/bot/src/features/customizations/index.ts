import { isByokProviderId, personas } from '@repo/ai';
import {
  addMcpServer,
  cancelReminder,
  clearUserCustomization,
  deleteChatgptAccount,
  deleteUserModelCredential,
  getChatgptAccount,
  getIdentityProfiles,
  getUserCustomization,
  listUserModelCredentials,
  pauseReminder,
  removeMcpServer,
  resumeReminder,
  setChatgptChatgptFirst,
  setCredentialServiceFallback,
  setCredentialValidation,
  setIdentityProfile,
  setUsageFooter,
  setUserCustomization,
  updateChatgptModel,
  updateUserModelCredentialConfig,
  upsertUserModelCredential,
} from '@repo/db/queries';
import { env } from '@/env';
import type { ModalSubmitEvent, ModalSubmitResult } from '@/harness';
import { mrkdwn, plainText } from '@/harness';
import {
  byokConfigured,
  encryptSecret,
  keyPreview,
  validateCredential,
} from '@/lib/byok';
import { bot, slack } from '@/lib/chat';
import {
  chatgptConfigured,
  completeChatgptLink,
  listChatgptModels,
  startChatgptLink,
} from '@/lib/chatgpt';
import { IDENTITY_TYPES, resetIdentityCache } from '@/lib/identity';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { eraseUserData, summarize } from './erase';
import {
  openedViewSchema,
  parseModalState,
  promptFromViewValues,
  slackActionViewSchema,
} from './schema';
import { publishHome } from './service';
import {
  buildChatgptLinkModal,
  buildChatgptModelModal,
  buildIdentityModal,
  buildMcpModal,
  buildModelKeyModal,
  buildPresetModal,
  buildPromptModal,
} from './views';

// Slack rejects an input-block error string longer than this.
const MODAL_ERROR_MAX = 300;

function isOwnerUser(userId: string): boolean {
  return Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
}

bot.onAppHomeOpened(async (event) => {
  await publishHome({ userId: event.userId }).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), userId: event.userId },
      'Failed to publish App Home'
    );
  });
});

bot.onAction('home_edit_prompt', async (event) => {
  if (!event.triggerId) {
    logger.warn(
      { userId: event.user.userId },
      'App Home action missing trigger ID'
    );
    return;
  }

  const opened = await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: {
        blocks: [
          {
            text: mrkdwn('Loading custom instructions...'),
            type: 'section',
          },
        ],
        callback_id: 'home_save_prompt',
        close: plainText('Cancel'),
        title: plainText('Custom Instructions'),
        type: 'modal',
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open custom instructions modal'
      );
      return null;
    });
  const view = openedViewSchema.safeParse(opened?.view);
  if (!view.success) {
    return;
  }

  const customization = await getUserCustomization(event.user.userId).catch(
    (error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to load custom instructions for modal'
      );
      return null;
    }
  );

  await slack.webClient.views
    .update({
      hash: view.data.hash,
      view: buildPromptModal({
        prompt: customization?.prompt ?? null,
      }) as never,
      view_id: view.data.id,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to load custom instructions modal'
      );
    });
});

bot.onAction('modal_toggle_presets', async (event) => {
  const raw = slackActionViewSchema.safeParse(event.raw);
  if (!(raw.success && raw.data.view)) {
    logger.warn(
      { userId: event.user.userId },
      'Preset toggle action missing modal view'
    );
    return;
  }

  const state = parseModalState({ metadata: raw.data.view.private_metadata });
  const prompt = promptFromViewValues({ values: raw.data.view.state?.values });

  await slack.webClient.views
    .update({
      hash: raw.data.view.hash,
      view: buildPromptModal({
        prompt,
        showPresets: !state.showPresets,
      }) as never,
      view_id: raw.data.view.id,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to toggle custom instruction presets'
      );
    });
});

bot.onAction('modal_load_preset', async (event) => {
  const preset = personas.find((persona) => persona.id === event.value);
  if (!(preset && event.triggerId)) {
    logger.warn(
      { presetId: event.value, userId: event.user.userId },
      'Preset load action missing preset or trigger ID'
    );
    return;
  }

  await slack.webClient.views
    .push({
      trigger_id: event.triggerId,
      view: buildPresetModal(preset) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        {
          ...toLogError(error),
          presetId: preset.id,
          userId: event.user.userId,
        },
        'Failed to open custom instruction preset'
      );
    });
});

bot.onAction('home_clear_prompt', async (event) => {
  await clearUserCustomization(event.user.userId)
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to clear custom instructions'
      );
    });
});

// Self-serve erase. Two buttons, same handler: `includeSettings` is the only
// difference (see erase.ts for why they're separate asks). Both are already
// behind Slack's own confirm dialog, which is the only confirmation there is —
// App Home has nowhere to put an ephemeral, so the receipt is DM'd instead.
const eraseHandler =
  (includeSettings: boolean) => async (event: { user: { userId: string } }) => {
    const userId = event.user.userId;
    try {
      const result = await eraseUserData({ includeSettings, userId });
      await publishHome({ userId });
      // The receipt matters as much as the deletion: it's how someone learns that
      // shared-channel reasoning and promoted memories are NOT covered, which they
      // can't tell from a button that just says "Forget me".
      const thread = await bot.openDM(userId);
      await thread.post({
        markdown: `*Done — here's exactly what was removed.*\n\n${summarize(result)}`,
      });
    } catch (error: unknown) {
      logger.error(
        { ...toLogError(error), includeSettings, userId },
        'Failed to erase user data'
      );
      // Never leave someone believing their data is gone when it isn't.
      await bot
        .openDM(userId)
        .then((thread) =>
          thread.post({
            markdown:
              "Something went wrong erasing your data, so *assume nothing was removed* and try again. If it keeps failing, tell the bot owner — don't just leave it.",
          })
        )
        .catch(() => undefined);
    }
  };

bot.onAction('home_forget_me', eraseHandler(false));
bot.onAction('home_erase_everything', eraseHandler(true));

bot.onAction('home_toggle_footer', async (event) => {
  // The button's value is the target state ('on'/'off'); fall back to reading
  // the current value if it's ever missing.
  const target = event.value
    ? event.value === 'on'
    : !(await getUserCustomization(event.user.userId))?.showUsageFooter;
  await setUsageFooter(event.user.userId, target)
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to toggle usage footer'
      );
    });
});

bot.onModalSubmit(
  ['home_save_prompt', 'home_save_preset_prompt'],
  async (event) => {
    const prompt = event.values.prompt?.trim();
    if (prompt === undefined) {
      return {
        action: 'errors',
        errors: { customization_prompt: 'Could not read custom instructions.' },
      };
    }

    try {
      if (prompt) {
        await setUserCustomization(event.user.userId, { prompt });
      } else {
        await clearUserCustomization(event.user.userId);
      }
    } catch (error) {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to save custom instructions'
      );
      return {
        action: 'errors',
        errors: {
          customization_prompt:
            'Could not save custom instructions. Try again.',
        },
      };
    }

    await publishHome({ userId: event.user.userId }).catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to refresh App Home after custom instructions save'
      );
    });

    if (event.callbackId === 'home_save_preset_prompt') {
      return { action: 'clear' };
    }
  }
);

// ── MCP servers (per-user, App Home) ────────────────────────────────────────

bot.onAction('home_add_mcp', async (event) => {
  if (!event.triggerId) {
    logger.warn(
      { userId: event.user.userId },
      'Add-MCP action missing trigger ID'
    );
    return;
  }
  await slack.webClient.views
    .open({ trigger_id: event.triggerId, view: buildMcpModal() as never })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open MCP modal'
      );
    });
});

bot.onAction('home_remove_mcp', async (event) => {
  const name = event.value;
  if (!name) {
    return;
  }
  await removeMcpServer({ name, userId: event.user.userId })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), name, userId: event.user.userId },
        'Failed to remove MCP server'
      );
    });
});

bot.onModalSubmit(
  'home_add_mcp_server',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    const name = event.values.mcp_name?.trim().toLowerCase();
    const url = event.values.mcp_url?.trim();
    const authorization = event.values.mcp_authorization?.trim() || undefined;
    if (!(name && /^[\w-]+$/.test(name))) {
      return {
        action: 'errors',
        errors: { mcp_name: 'Use letters, digits, - or _ only.' },
      };
    }
    if (!(url && /^https?:\/\//.test(url))) {
      return {
        action: 'errors',
        errors: { mcp_url: 'Enter an http(s) URL.' },
      };
    }
    try {
      await addMcpServer({
        authorization,
        name,
        url,
        userId: event.user.userId,
      });
    } catch (error) {
      logger.warn(
        { ...toLogError(error), name, userId: event.user.userId },
        'Failed to add MCP server'
      );
      return {
        action: 'errors',
        errors: { mcp_url: 'Could not save this server. Try again.' },
      };
    }
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);

// ── Model keys / BYOK (per-user, App Home) ──────────────────────────────────

// A user's own key never leaves this flow in the clear: it is encrypted before
// it reaches the DB, never written to a log, never placed in the modal's
// private_metadata, and never shown back (only a `…tail` preview is stored).

bot.onAction('home_add_model_key', async (event) => {
  if (!(event.triggerId && byokConfigured())) {
    return;
  }
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: buildModelKeyModal() as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open model key modal'
      );
    });
});

bot.onAction('home_edit_model_key', async (event) => {
  const provider = event.value;
  if (!(event.triggerId && provider && byokConfigured())) {
    return;
  }
  const credentials = await listUserModelCredentials(event.user.userId).catch(
    () => []
  );
  const credential = credentials.find((row) => row.provider === provider);
  if (!credential) {
    return;
  }
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: buildModelKeyModal(credential) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), provider, userId: event.user.userId },
        'Failed to open model key modal'
      );
    });
});

bot.onAction('home_remove_model_key', async (event) => {
  const provider = event.value;
  if (!provider) {
    return;
  }
  await deleteUserModelCredential({ provider, userId: event.user.userId })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), provider, userId: event.user.userId },
        'Failed to remove model key'
      );
    });
});

bot.onAction('home_toggle_model_key_fallback', async (event) => {
  // value is `<provider>:<target state>`, so a stale home view can't flip it the
  // wrong way.
  const [provider, target] = (event.value ?? '').split(':');
  if (!(provider && (target === 'on' || target === 'off'))) {
    return;
  }
  await setCredentialServiceFallback({
    allowed: target === 'on',
    provider,
    userId: event.user.userId,
  })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), provider, userId: event.user.userId },
        'Failed to toggle model key service fallback'
      );
    });
});

bot.onModalSubmit(
  'home_save_model_key',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    if (!byokConfigured()) {
      return;
    }
    const provider = event.values.byok_provider?.trim();
    const model = event.values.byok_model?.trim();
    const key = event.values.byok_key?.trim();
    const baseUrl = event.values.byok_base_url?.trim() || null;
    if (!(provider && isByokProviderId(provider))) {
      return {
        action: 'errors',
        errors: { byok_provider: 'Choose a provider.' },
      };
    }
    if (!model) {
      return { action: 'errors', errors: { byok_model: 'Enter a model id.' } };
    }
    if (provider === 'custom' && !baseUrl) {
      return {
        action: 'errors',
        errors: { byok_base_url: 'A custom provider needs a base URL.' },
      };
    }

    const existing = (
      await listUserModelCredentials(event.user.userId).catch(() => [])
    ).find((row) => row.provider === provider);

    // Editing without pasting a key again: keep the stored secret and update
    // only the model / base URL.
    if (!key) {
      if (!existing) {
        return {
          action: 'errors',
          errors: { byok_key: 'Enter your API key.' },
        };
      }
      try {
        await updateUserModelCredentialConfig({
          baseUrl,
          model,
          provider,
          userId: event.user.userId,
        });
      } catch (error) {
        logger.warn(
          { ...toLogError(error), provider, userId: event.user.userId },
          'Failed to update model key config'
        );
        return {
          action: 'errors',
          errors: { byok_model: 'Could not save. Try again.' },
        };
      }
      await publishHome({ userId: event.user.userId }).catch(() => undefined);
      return;
    }

    // Check the key against the provider before storing it, so a typo surfaces
    // here rather than as a failed turn later.
    const check = await validateCredential({
      apiKey: key,
      baseUrl,
      model,
      provider,
    });
    if (!check.valid) {
      return {
        action: 'errors',
        errors: {
          byok_key: (check.message ?? 'The provider rejected this key.').slice(
            0,
            MODAL_ERROR_MAX
          ),
        },
      };
    }

    try {
      await upsertUserModelCredential({
        baseUrl,
        encryptedKey: encryptSecret(key),
        keyPreview: keyPreview(key),
        model,
        provider,
        // Preserve the user's existing fallback choice across a rotation.
        serviceFallback: existing?.serviceFallback ?? false,
        userId: event.user.userId,
      });
      await setCredentialValidation({
        provider,
        status: 'valid',
        userId: event.user.userId,
      });
    } catch (error) {
      // Log the failure WITHOUT the key or anything derived from it.
      logger.warn(
        { ...toLogError(error), provider, userId: event.user.userId },
        'Failed to save model key'
      );
      return {
        action: 'errors',
        errors: { byok_key: 'Could not save this key. Try again.' },
      };
    }
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);

// ── Sign in with ChatGPT (per-user, App Home) ───────────────────────────────

// The tokens never leave this flow in the clear: the OAuth exchange happens
// host-side, the access/refresh tokens are encrypted before the DB, never
// logged, and never shown back. See lib/chatgpt.

bot.onAction('home_link_chatgpt', async (event) => {
  if (!(event.triggerId && chatgptConfigured())) {
    return;
  }
  const authUrl = startChatgptLink(event.user.userId);
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: buildChatgptLinkModal(authUrl) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open ChatGPT link modal'
      );
    });
});

bot.onModalSubmit(
  'home_save_chatgpt',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    if (!chatgptConfigured()) {
      return;
    }
    const pasted = event.values.chatgpt_callback?.trim();
    const model = event.values.chatgpt_model?.trim();
    if (!pasted) {
      return {
        action: 'errors',
        errors: { chatgpt_callback: 'Paste the URL you were redirected to.' },
      };
    }
    if (!model) {
      return {
        action: 'errors',
        errors: { chatgpt_model: 'Enter a model id.' },
      };
    }
    const result = await completeChatgptLink({
      model,
      pasted,
      userId: event.user.userId,
    });
    if (!result.ok) {
      return {
        action: 'errors',
        errors: {
          chatgpt_callback: (
            result.error ?? 'Could not link your account.'
          ).slice(0, MODAL_ERROR_MAX),
        },
      };
    }
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);

bot.onAction('home_edit_chatgpt_model', async (event) => {
  if (!(event.triggerId && chatgptConfigured())) {
    return;
  }
  const account = await getChatgptAccount(event.user.userId).catch(
    () => undefined
  );
  if (!account) {
    return;
  }
  // Populate the picker with the models this account can actually use; on a
  // fetch failure the modal falls back to a free-text field.
  const models = await listChatgptModels(event.user.userId).catch(() => []);
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: buildChatgptModelModal(account, models) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open ChatGPT model modal'
      );
    });
});

bot.onModalSubmit(
  'home_save_chatgpt_model',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    const model = event.values.chatgpt_model?.trim();
    if (!model) {
      return {
        action: 'errors',
        errors: { chatgpt_model: 'Enter a model id.' },
      };
    }
    await updateChatgptModel({ model, userId: event.user.userId }).catch(
      (error: unknown) => {
        logger.warn(
          { ...toLogError(error), userId: event.user.userId },
          'Failed to update ChatGPT model'
        );
      }
    );
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);

bot.onAction('home_unlink_chatgpt', async (event) => {
  await deleteChatgptAccount(event.user.userId)
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to unlink ChatGPT account'
      );
    });
});

bot.onAction('home_toggle_chatgpt_first', async (event) => {
  const target = event.value;
  if (!(target === 'on' || target === 'off')) {
    return;
  }
  await setChatgptChatgptFirst({
    chatgptFirst: target === 'on',
    userId: event.user.userId,
  })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to toggle ChatGPT ordering'
      );
    });
});

// ── Reminders (per-user, App Home) ──────────────────────────────────────────

async function handleReminderAction(
  event: { user: { userId: string }; value?: string },
  op: (args: { id: string; userId: string }) => Promise<boolean>,
  label: string
): Promise<void> {
  const id = event.value;
  if (!id) {
    return;
  }
  await op({ id, userId: event.user.userId })
    .then(() => publishHome({ userId: event.user.userId }))
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        `Failed to ${label} reminder`
      );
    });
}

bot.onAction('home_pause_reminder', (event) =>
  handleReminderAction(event, pauseReminder, 'pause')
);
bot.onAction('home_resume_reminder', (event) =>
  handleReminderAction(event, resumeReminder, 'resume')
);
bot.onAction('home_cancel_reminder', (event) =>
  handleReminderAction(event, cancelReminder, 'cancel')
);

// ── Identity (owner-only, App Home) ─────────────────────────────────────────

bot.onAction('home_edit_identity', async (event) => {
  if (!(event.triggerId && isOwnerUser(event.user.userId))) {
    return;
  }
  const profiles = await getIdentityProfiles().catch(() => []);
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: buildIdentityModal(profiles) as never,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to open identity modal'
      );
    });
});

bot.onModalSubmit(
  'home_save_identity',
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    if (!isOwnerUser(event.user.userId)) {
      return;
    }
    try {
      for (const type of IDENTITY_TYPES) {
        await setIdentityProfile(type, {
          icon: event.values[`identity_${type}_icon`]?.trim() || null,
        });
      }
      resetIdentityCache();
    } catch (error) {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to save identity profiles'
      );
      return {
        action: 'errors',
        errors: { identity_normal_icon: 'Could not save. Try again.' },
      };
    }
    await publishHome({ userId: event.user.userId }).catch(() => undefined);
    return;
  }
);
