import type { AskState } from './state';

/**
 * The turns currently blocked on a question, keyed by the question id carried
 * in the message's metadata.
 *
 * In-memory on purpose: what is being held here is a running turn, and a turn
 * does not survive a restart either. The MESSAGE's state lives in Slack
 * metadata, so after a restart the buttons still work and still record answers
 * — there is simply no longer a turn listening, which is the honest outcome.
 */
interface Waiter {
  resolve: (state: AskState) => void;
}

const waiters = new Map<string, Waiter>();

export function waitForAnswers(id: string): Promise<AskState | null> {
  return new Promise<AskState | null>((resolve) => {
    waiters.set(id, { resolve: (state) => resolve(state) });
  });
}

/** Wake the turn waiting on this question, if it is still running. */
export function settleAnswers(id: string, state: AskState): void {
  const waiter = waiters.get(id);
  if (!waiter) {
    return;
  }
  waiters.delete(id);
  waiter.resolve(state);
}

export function abandonQuestion(id: string): void {
  waiters.delete(id);
}
