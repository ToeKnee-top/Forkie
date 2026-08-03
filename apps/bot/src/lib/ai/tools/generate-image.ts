import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';
import type { GeneratedImage } from '@/types/tools/generate-image';

// Image generation goes straight to HackClub's OpenAI-compatible
// `/images/generations` endpoint (model google/gemini-3.1-flash-image), which
// is verified working and billed to HACKCLUB_API_KEY. We call it directly with
// fetch rather than through the AI SDK's `generateImage` + OpenRouter provider,
// whose image path did not actually reach this endpoint (the "image gen not
// working" bug).
//
// This is deliberately the SERVICE image provider even on a BYOK turn: a user's
// stored key is a chat-completions credential (we never asked them for an
// image-capable one, and most aren't), so routing images at it would just fail.
// Image generation therefore always spends the service budget, regardless of
// whose key is answering the rest of the turn.
const IMAGES_URL = 'https://ai.hackclub.com/proxy/v1/images/generations';
const IMAGE_MODEL = 'google/gemini-3.1-flash-image';

// Detect the media type from the decoded bytes' magic number so Slack shows the
// right file type (this endpoint returns JPEG, but don't hard-code it).
function detectMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return 'image/png';
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49) {
    return 'image/webp';
  }
  return 'image/png';
}

// Every generated image is written to the workspace as well as (optionally)
// posted: an upload that fails, or a picture the model wants to edit or serve
// from a site, is otherwise gone the moment the call returns. Best effort — a
// sandbox that won't take the write must not fail the generation.
async function saveToSandbox({
  bytes,
  getSandboxContext,
  index,
  mediaType,
}: {
  bytes: Uint8Array;
  getSandboxContext: () => SandboxContext;
  index: number;
  mediaType: string;
}): Promise<string | null> {
  const extension = mediaType.split('/').at(1) ?? 'png';
  try {
    const context = getSandboxContext();
    const path = nodePath.join(
      context.sessionWorkDir,
      'generated-images',
      `kyto-image-${Date.now()}-${index + 1}.${extension}`
    );
    await context.session.writeBinaryFile({ content: bytes, path });
    return path;
  } catch {
    return null;
  }
}

export function generateImageTool({
  getSandboxContext,
  upload,
}: {
  /** Where generated images are saved, so they survive an upload that fails. */
  getSandboxContext: () => SandboxContext;
  upload: (image: GeneratedImage) => Promise<void>;
}) {
  return tool({
    description:
      'Generate one or more AI images from a prompt. By default they are posted to the current Slack thread; pass upload:false to generate quietly (e.g. an asset for a site you are building, or an input for further editing). Either way every image is also saved into your sandbox workspace and the paths come back in the result, so you can edit, reuse, or upload it later.',
    inputSchema: z.object({
      n: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(1)
        .describe('How many images to generate.'),
      prompt: z
        .string()
        .min(1)
        .max(1500)
        .describe('What to generate, with the visual details.'),
      upload: z
        .boolean()
        .default(true)
        .describe(
          'Post the images to this Slack thread. Set false to only save them to the sandbox.'
        ),
    }),
    execute: async ({ n, prompt, upload: shouldUpload }) => {
      try {
        const response = await fetch(IMAGES_URL, {
          body: JSON.stringify({ model: IMAGE_MODEL, n, prompt }),
          headers: {
            Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            error: `Image generation failed (${response.status}): ${body.slice(0, 300)}`,
            success: false,
          };
        }
        const payload = (await response.json()) as {
          data?: { b64_json?: string; url?: string }[];
        };
        const entries = payload.data ?? [];
        if (entries.length === 0) {
          return {
            error: 'Image generation returned no images.',
            success: false,
          };
        }
        const total = entries.length;
        const paths: string[] = [];
        let uploaded = 0;
        for (const [index, entry] of entries.entries()) {
          let bytes: Uint8Array | undefined;
          if (entry.b64_json) {
            bytes = Uint8Array.from(Buffer.from(entry.b64_json, 'base64'));
          } else if (entry.url) {
            const img = await fetch(entry.url);
            bytes = new Uint8Array(await img.arrayBuffer());
          }
          if (!bytes) {
            continue;
          }
          const mediaType = detectMediaType(bytes);
          const saved = await saveToSandbox({
            bytes,
            getSandboxContext,
            index,
            mediaType,
          });
          if (saved) {
            paths.push(saved);
          }
          if (shouldUpload) {
            await upload({ bytes, index, mediaType, total });
            uploaded += 1;
          }
        }
        const plural = total === 1 ? '' : 's';
        return {
          paths,
          prompt,
          summary: shouldUpload
            ? `Generated and uploaded ${total} image${plural} to this Slack thread (also saved in the sandbox: ${paths.join(', ') || 'none'}).`
            : `Generated ${total} image${plural} in the sandbox (not posted to Slack): ${paths.join(', ') || 'none'}.`,
          uploaded,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
