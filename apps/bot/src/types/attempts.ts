import type { ModelAttempt } from '@repo/ai';

export interface AttemptFailure {
  attempt: ModelAttempt;
  error: unknown;
}
