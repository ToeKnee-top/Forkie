// Provider identity strings, in their own module so reading one does NOT drag in
// `keys()` and its env validation. `providers/attempts.ts` calls `keys()` at
// module scope, so anything importing a constant from there needed a full,
// valid environment — which is why routing logic that only needs to compare a
// provider name could not be unit-tested. Import these from
// `@repo/ai/providers/names` in code (and tests) that has no business holding an
// API key.
//
// These strings are also the `failedKeys` namespace (`provider:model`), so they
// must stay stable and must not collide with a BYOK provider id (see
// providers/byok, which namespaces its own).

export const GEMINI_PROVIDER = 'gemini';
export const HACKCLUB_PROVIDER = 'hackclub';

export const GROQ_PROVIDER = 'groq';
