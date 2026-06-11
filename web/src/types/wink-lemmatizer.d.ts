/**
 * Type stub for `wink-lemmatizer` (the package ships no .d.ts).
 *
 * We only call three functions; everything else is `unknown`. Keep this
 * surface narrow so a future bump of the upstream API surfaces as a TS error.
 */
declare module "wink-lemmatizer" {
  export function noun(word: string): string;
  export function verb(word: string): string;
  export function adjective(word: string): string;

  const _default: {
    noun(word: string): string;
    verb(word: string): string;
    adjective(word: string): string;
  };
  export default _default;
}
