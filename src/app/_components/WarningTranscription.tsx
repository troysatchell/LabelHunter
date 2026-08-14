/**
 * The government-warning transcription with its deviations marked
 * (TRO-582). Wraps each word that does not align with the statutory text
 * in a `<mark>` — background tint plus weight, never color alone, so the
 * signal survives grayscale and low vision (TH-R3).
 *
 * Display-only: the verdict and its reason come from the warning
 * comparator; this component only shows the reviewer WHERE to look.
 */
import { CANONICAL_WARNING_TEXT } from "../../server/warning/canonical";
import { diffWords } from "../_lib/word-diff";

export interface WarningTranscriptionProps {
  transcription: string;
}

export function WarningTranscription({ transcription }: WarningTranscriptionProps) {
  const tokens = diffWords(CANONICAL_WARNING_TEXT, transcription);
  return (
    <>
      {tokens.map((token, index) => (
        // Index keys are safe here: the token list is derived wholly from
        // props and never reorders in place.
        <span key={index}>
          {index > 0 ? " " : ""}
          {token.omitted ? (
            // Required words the label DROPS with no replacement — an
            // omission is a violation the reviewer cannot see in the
            // transcription alone, so it gets an explicit, readable
            // indicator at the spot where the words should be.
            <mark className="warning-diff-mark">[missing: {token.text}]</mark>
          ) : token.differs ? (
            <mark className="warning-diff-mark">{token.text}</mark>
          ) : (
            token.text
          )}
        </span>
      ))}
    </>
  );
}
