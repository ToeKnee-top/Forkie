// A model that means to stay quiet is supposed to CALL the `skip` tool. Some
// write the word instead — and then the whole "reply" is the bare token, which
// got posted to the thread as a message reading `skip`, followed by a usage
// footer. Seen three times in a row on subagent wake turns, where "call skip
// instead of posting filler" is exactly what the prompt asks for.
//
// Only an entire reply that is nothing but the token counts. Someone asking kyto
// to "skip the first step" gets a reply containing the word, and that must post
// normally — so this deliberately does NOT strip a trailing `skip` off real prose.
const BARE_SKIP =
  /^\s*(?:`{1,3})?\s*skip(?:\s*\(\s*\))?\s*[.!]?\s*(?:`{1,3})?\s*$/i;

export function isBareSkipText(text: string): boolean {
  // An EMPTY reply is a failed attempt that must fall back to another model, not
  // a deliberate silence, so it must not match here.
  return text.trim().length > 0 && BARE_SKIP.test(text);
}
