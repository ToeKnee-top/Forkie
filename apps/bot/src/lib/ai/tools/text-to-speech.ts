import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';

// Two backends, tried in order:
//
// 1. Replicate via HackClub's proxy (HACKCLUB_REPLICATE_API_KEY — separate
//    from HACKCLUB_API_KEY, since Replicate access is gated per-key on their
//    proxy; the main key 401s there while this one works). Model
//    minimax/speech-02-turbo. Preferred when configured.
// 2. Gemini Flash TTS via the native Interactions API (NOT the OpenAI-compat
//    endpoint used elsewhere — TTS isn't exposed there). POST
//    .../v1beta/interactions with { model, input, response_format: { type:
//    'audio' }, generation_config: { speech_config: [{ voice }] } }, returning
//    base64 PCM (24kHz, 16-bit, mono) that we wrap in a WAV header. Capped at
//    ~10 requests/day on the owner's key — fallback only.
const REPLICATE_PREDICTIONS_URL =
  'https://ai.hackclub.com/proxy/v1/replicate/models/minimax/speech-02-turbo/predictions';
const GEMINI_INTERACTIONS_URL =
  'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const RIFF_CHUNK_OVERHEAD = 36;
const PCM_FORMAT = 1;
const BITS_PER_BYTE = 8;

const GEMINI_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck'] as const;

function wavHeader(pcmLength: number): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0);
  header.writeUInt32LE(RIFF_CHUNK_OVERHEAD + pcmLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * BITS_PER_BYTE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

async function speakViaReplicate(
  text: string,
  apiKey: string
): Promise<Buffer> {
  const response = await fetch(REPLICATE_PREDICTIONS_URL, {
    body: JSON.stringify({ input: { text } }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    method: 'POST',
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { detail?: string; error?: string; output?: string }
    | undefined;
  if (!response.ok) {
    throw new Error(
      `Replicate TTS failed (${response.status}): ${payload?.error ?? payload?.detail ?? 'unknown error'}`
    );
  }
  if (!payload?.output) {
    throw new Error(`Replicate TTS returned no audio: ${payload?.error ?? ''}`);
  }
  const audio = await fetch(payload.output);
  if (!audio.ok) {
    throw new Error(`Failed to download generated audio (${audio.status}).`);
  }
  return Buffer.from(await audio.arrayBuffer());
}

async function speakViaGemini(
  text: string,
  voice: string,
  apiKey: string
): Promise<Buffer> {
  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    body: JSON.stringify({
      generation_config: { speech_config: [{ voice }] },
      input: text,
      model: GEMINI_TTS_MODEL,
      response_format: { type: 'audio' },
    }),
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    method: 'POST',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Gemini TTS request failed (${response.status}): ${body.slice(0, 500)}`
    );
  }
  const payload = (await response.json()) as {
    output_audio?: { data?: string };
  };
  const base64 = payload.output_audio?.data;
  if (!base64) {
    throw new Error('Gemini TTS returned no audio.');
  }
  const pcm = Buffer.from(base64, 'base64');
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

export function textToSpeechTool({
  upload,
}: {
  upload: (input: { data: Buffer; filename: string }) => Promise<void>;
}) {
  const replicateKey = env.HACKCLUB_REPLICATE_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;
  return tool({
    description: replicateKey
      ? 'Convert text to spoken audio and upload it to the thread as an .mp3 file.'
      : "Convert text to spoken audio (Gemini Flash TTS) and upload it to the thread as a .wav file. Capped at ~10 requests/day on the owner's Gemini key, so use it deliberately, not for every reply.",
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'The text to speak. Can include natural-language style direction, e.g. "Say cheerfully: ...".'
        ),
      voice: z
        .enum(GEMINI_VOICES)
        .default('Kore')
        .describe('Prebuilt voice name (only used for the Gemini fallback).'),
    }),
    execute: async ({ text, voice }) => {
      if (!(replicateKey || geminiKey)) {
        return {
          error:
            'Text-to-speech requires HACKCLUB_REPLICATE_API_KEY or GEMINI_API_KEY to be configured.',
          success: false,
        };
      }
      try {
        const audio = replicateKey
          ? await speakViaReplicate(text, replicateKey)
          : await speakViaGemini(text, voice, geminiKey as string);
        const filename = `kyto-speech-${Date.now()}.${replicateKey ? 'mp3' : 'wav'}`;
        await upload({ data: audio, filename });
        return { filename, success: true };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
