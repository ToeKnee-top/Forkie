import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const OPENWEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';

function weatherLink(city: string): string {
  return `https://openweathermap.org/city?q=${encodeURIComponent(city)}`;
}

const weatherSchema = z
  .looseObject({
    weather: z.array(z.looseObject({ description: z.string().optional() })),
    main: z.looseObject({
      temp: z.number().optional(),
      feels_like: z.number().optional(),
      humidity: z.number().optional(),
    }),
    wind: z
      .looseObject({ speed: z.number().optional() })
      .optional(),
  })
  .passthrough();

/**
 * Port of QuackX's `/quackx-weather` into an on-demand kyto tool. Unlike the
 * slash command it spawns no fixed behaviour — an agent calls it only when
 * someone asks for the weather, so it is safe to ship without changing how the
 * bot behaves on its own.
 */
export function weatherTool() {
  return tool({
    description:
      "Get current weather for a city (condition, temperature, feels-like, humidity). Use when someone asks about the weather anywhere in the world. Requires OPENWEATHER_API_KEY to be set; reports clearly if it isn't.",
    inputSchema: z.object({
      city: z
        .string()
        .min(1)
        .max(120)
        .describe('City name/query, e.g. "Houston" or "London, UK".'),
    }),
    execute: async ({ city }) => {
      try {
        if (!process.env.OPENWEATHER_API_KEY) {
          return {
            error:
              'OPENWEATHER_API_KEY is not set. The weather tool needs a free key from https://openweathermap.org/api to be configured on the server before it can fetch weather.',
            success: false,
          };
        }
        const url = `${OPENWEATHER_URL}?q=${encodeURIComponent(
          city
        )}&units=imperial&appid=${process.env.OPENWEATHER_API_KEY}`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) {
          // OpenWeather returns HTTP 404 for an unknown city.
          const reason =
            response.status === 404
              ? `Couldn't find a city matching "${city}". Try the full name or "City, CountryCode", e.g. "New York, US".`
              : `Weather API returned HTTP ${response.status}.`;
          return { error: reason, success: false };
        }
        const parsed = weatherSchema.safeParse(data);
        if (!parsed.success) {
          logger.warn(
            { error: parsed.error.message },
            '[weather] unexpected payload shape'
          );
          return { error: 'Weather API returned an unexpected shape.', success: false };
        }
        const w = parsed.data;
        const desc = w.weather?.[0]?.description ?? 'unknown';
        const temp = w.main?.temp;
        const feels = w.main?.feels_like;
        const humidity = w.main?.humidity;
        const wind = w.wind?.speed;
        const parts = [
          `🌤️ *Weather for ${city}:*`,
          `• Condition: ${desc}`,
        ];
        if (temp != null) parts.push(`• Temperature: ${temp}°F`);
        if (feels != null) parts.push(`• Feels like: ${feels}°F`);
        if (humidity != null) parts.push(`• Humidity: ${humidity}%`);
        if (wind != null) parts.push(`• Wind: ${wind} mph`);
        return { text: parts.join('\n'), success: true };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[weather] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
