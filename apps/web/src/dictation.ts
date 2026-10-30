import { useEffect, useRef, useState } from "react";

// The Web Speech API, as far as dictation uses it. Chrome and Safari ship it prefixed, Firefox not at all.
type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

const speech = window as unknown as {
  SpeechRecognition?: new () => Recognizer;
  webkitSpeechRecognition?: new () => Recognizer;
};
const Recognition = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it in the browser's site settings.",
  "service-not-allowed": "This browser does not allow dictation here.",
  "audio-capture": "No microphone found.",
  "no-speech": "Nothing heard. Try again.",
  network: "Dictation needs a network connection.",
};

/**
 * Dictation into a text field: what is said is added after the text the field had when dictation
 * started, and the words still being recognised show as they come in.
 */
export function useDictation(onText: (text: string) => void) {
  const recognizer = useRef<Recognizer>(null);
  const write = useRef(onText);
  write.current = onText;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => () => recognizer.current?.abort(), []);

  function start(before: string) {
    if (!Recognition) {
      setError("This browser has no dictation. Open the app in Chrome, Edge or Safari.");
      return;
    }
    if (recognizer.current) return;
    const r = new Recognition();
    r.lang = "en-GB";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      const said = Array.from(event.results, (result) => result[0]?.transcript.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      write.current([before.trimEnd(), said].filter(Boolean).join(" "));
    };
    r.onerror = (event) => setError(ERRORS[event.error]);
    r.onend = () => {
      recognizer.current = null;
      setListening(false);
    };
    recognizer.current = r;
    setError(undefined);
    setListening(true);
    r.start();
  }

  /** Stops listening and keeps the words recognised so far. */
  function stop() {
    recognizer.current?.stop();
  }

  /** Stops listening and drops words not yet recognised, so the field no longer changes. */
  function cancel() {
    recognizer.current?.abort();
  }

  return { listening, error, start, stop, cancel };
}
