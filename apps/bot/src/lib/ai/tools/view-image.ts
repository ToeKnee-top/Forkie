import nodePath from 'node:path/posix';
import {
  describeImages,
  type ImageInput,
  modelSupportsVision,
  PRIMARY_ATTEMPT,
  type SandboxContext,
  visionAttempt,
} from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';

// Look at an image sitting in the sandbox — a screenshot the model took, a
// downloaded or generated image, an attachment saved to disk. readFile only
// decodes bytes as text (garbage for a PNG), so this is the ONLY way the model
// actually SEES a sandbox image: it hands the bytes to `pushImage`, and the
// agent loop injects them as a user message on the next step (a tool RESULT
// image is dropped to JSON by the openai-compatible providers).

const MAX_VISION_BYTES = 8 * 1024 * 1024;

const EXT_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function mediaTypeFromPath(path: string): string | undefined {
  return EXT_MEDIA[nodePath.extname(path).toLowerCase()];
}

function resolvePath(context: SandboxContext, path: string): string {
  return nodePath.normalize(
    path.startsWith('/') ? path : nodePath.join(context.sessionWorkDir, path)
  );
}

export function viewImageTool({
  getSandboxContext,
  pushImage,
}: {
  getSandboxContext: () => SandboxContext;
  pushImage: (image: ImageInput) => void;
}) {
  return tool({
    description:
      'Look at an image file in your sandbox so YOU can actually SEE it (a screenshot you took, a downloaded/generated image, an attachment on disk). readFile only gives you the raw bytes as text — use THIS to view the picture. Supported: png, jpg, webp, gif. The image enters your view on your next step, so call it, then describe or act on what you see. NOTE: this is for YOUR eyes only — it does NOT send or show the image to anyone in Slack. When the user asks you to SEND/SHOW/SHARE a picture, use uploadFile, not this.',
    inputSchema: z.object({
      path: z.string().describe('Path to the image file in the sandbox.'),
    }),
    execute: async ({ path }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const mediaType = mediaTypeFromPath(resolved);
      if (!mediaType) {
        return {
          error:
            'Unsupported image type. Supported: png, jpg, jpeg, webp, gif.',
          viewing: false,
        };
      }
      const bytes = await context.session.readBinaryFile({ path: resolved });
      if (!bytes) {
        return { error: `No file found at ${path}.`, viewing: false };
      }
      if (bytes.byteLength > MAX_VISION_BYTES) {
        return {
          error: `Image is too large to view (${Math.round(bytes.byteLength / 1024 / 1024)}MB, max 8MB). Resize it first (e.g. with sharp/imagemagick in the sandbox).`,
          viewing: false,
        };
      }
      const image: ImageInput = {
        bytes: new Uint8Array(bytes),
        mediaType,
        path,
      };
      // A text-only primary (deepseek-v4-flash) 404s on image input, so it can
      // never be shown the pixels. Describe the image with Gemini and hand back
      // the text right now instead of queuing it for a vision step that would
      // fail. Falls through to the normal vision path if description is
      // unavailable (no Gemini key) or fails.
      if (!modelSupportsVision(PRIMARY_ATTEMPT.model) && visionAttempt) {
        const description = await describeImages({
          attempt: visionAttempt,
          images: [image],
        });
        if (description) {
          return { description, path, viewing: true };
        }
      }
      pushImage(image);
      return {
        note: 'Loaded — you will see this image on your next step.',
        path,
        viewing: true,
      };
    },
  });
}
