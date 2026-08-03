import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const keys = () =>
  createEnv({
    server: {
      HACKCLUB_API_KEY: z.string().min(1).startsWith('sk-hc-'),
      OPENCODE_API_KEY: z.string().min(1).optional(),
      GROQ_API_KEY: z.string().min(1).optional(),
      INFERENCE_API_KEY: z.string().min(1).optional(),
      GEMINI_API_KEY: z.string().min(1).optional(),
      GEMINI_BASE_URL: z.url().optional(),
      EXA_API_KEY: z.string().min(1),
    },
    runtimeEnv: {
      HACKCLUB_API_KEY: process.env.HACKCLUB_API_KEY,
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      INFERENCE_API_KEY: process.env.INFERENCE_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
      EXA_API_KEY: process.env.EXA_API_KEY,
    },
    emptyStringAsUndefined: true,
  });
