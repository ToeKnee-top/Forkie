// Describe images with a vision model so a TEXT-ONLY primary (deepseek-v4-flash,
// served by a Cloudflare endpoint that 404s on image input) can still "see" what
// a user attached: Gemini looks at the pixels and returns a thorough text
// description, which is fed to the primary as ordinary text. One extra Gemini
// call per image-carrying turn, on the owner's key (separate quota) — far
// cheaper than burning a doomed primary attempt on every screenshot.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type { ImageInput } from './agent';
import type { ModelAttempt } from './providers/attempts';

// Cap how many images one turn describes, so a bulk upload can't fan out into a
// huge multi-image vision call. The rest are still on disk in the sandbox for a
// tool to read; only their inline description is bounded.
const MAX_DESCRIBED_IMAGES = 6;

const DESCRIBE_INSTRUCTION =
  'You are describing image(s) for a text-only AI assistant that cannot see them. ' +
  'For each image, transcribe ALL visible text verbatim (treat this as OCR), and ' +
  'describe layout/UI, code, diagrams, charts, tables, people, objects and colors — ' +
  'anything that could matter to answering a question about it. Be thorough and ' +
  'factual; do not speculate or add commentary. If there are multiple images, label ' +
  'them Image 1, Image 2, … in order.';

/**
 * Return a text description of the given images, or null if there is nothing to
 * describe or the vision call failed (callers fall back to sending the raw
 * images, or to no description — never to a broken turn).
 */
export async function describeImages({
  attempt,
  images,
  signal,
}: {
  attempt: ModelAttempt;
  images: ImageInput[];
  signal?: AbortSignal;
}): Promise<string | null> {
  const usable = images.slice(0, MAX_DESCRIBED_IMAGES);
  if (usable.length === 0) {
    return null;
  }
  const model = createOpenAICompatible({
    apiKey: attempt.apiKey,
    baseURL: attempt.baseURL,
    name: attempt.provider,
  }).chatModel(attempt.model);
  try {
    const { text } = await generateText({
      abortSignal: signal,
      messages: [
        {
          content: [
            { text: DESCRIBE_INSTRUCTION, type: 'text' as const },
            ...usable.map((image) => ({
              data: image.bytes,
              mediaType: image.mediaType,
              type: 'file' as const,
            })),
          ],
          role: 'user' as const,
        },
      ],
      model,
    });
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
