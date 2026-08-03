import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import type { Message } from '@/harness';
import { sanitizeFilename } from '@/lib/utils/sanitize';
import type { SeededAttachment } from '@/types/attachments';

export async function seedAttachments({
  message,
  sandboxContext,
}: {
  message: Message;
  sandboxContext: SandboxContext;
}): Promise<SeededAttachment[]> {
  const seeded = await Promise.all(
    message.attachments.map((attachment, index) =>
      seedAttachment({ attachment, index, message, sandboxContext })
    )
  );
  return seeded.filter((entry): entry is SeededAttachment => entry !== null);
}

async function seedAttachment({
  attachment,
  index,
  message,
  sandboxContext,
}: {
  attachment: Message['attachments'][number];
  index: number;
  message: Message;
  sandboxContext: SandboxContext;
}): Promise<SeededAttachment | null> {
  const data = attachment.fetchData
    ? await attachment.fetchData()
    : attachment.data;
  if (!data) {
    return null;
  }

  const fallback = `attachment-${index + 1}`;
  const filename =
    sanitizeFilename(nodePath.basename(attachment.name || fallback)) ||
    fallback;
  const messageDir = sanitizeFilename(message.id) || 'message';
  const path = nodePath.join(
    sandboxContext.sessionWorkDir,
    'attachments',
    messageDir,
    filename
  );
  const bytes =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : new Uint8Array(data);
  await sandboxContext.session.writeBinaryFile({ content: bytes, path });
  return {
    imageBytes: isVisionImage(attachment.mimeType, bytes.byteLength)
      ? bytes
      : undefined,
    mimeType: attachment.mimeType,
    name: filename,
    path,
    type: attachment.type,
  };
}

// Images the model can be shown directly. Capped so a giant upload doesn't blow
// up the request; the file is still on disk for the model to process in code.
const MAX_VISION_BYTES = 8 * 1024 * 1024;
const VISION_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

function isVisionImage(
  mimeType: string | undefined,
  byteLength: number
): boolean {
  return (
    mimeType !== undefined &&
    VISION_MIME.test(mimeType) &&
    byteLength <= MAX_VISION_BYTES
  );
}

export function promptWithAttachments({
  attachments,
  text,
}: {
  attachments: SeededAttachment[];
  text: string;
}): string {
  if (attachments.length === 0) {
    return text;
  }
  const lines = attachments.map(
    (attachment) =>
      `- ${attachment.name} (${attachment.type}${attachment.mimeType ? `, ${attachment.mimeType}` : ''}): ${attachment.path}`
  );
  return [
    text,
    '',
    'Attached files have already been downloaded into the sandbox workspace:',
    ...lines,
    'Use these local paths when reading, editing, or uploading the files.',
  ].join('\n');
}
