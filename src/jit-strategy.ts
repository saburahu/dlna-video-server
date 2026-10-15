import type { Mode } from './playback-decision.js';

/** All strategies have an explicit execution boundary. No legacy TS fallback. */
export function jitExecutorKind(strategy: Mode) {
  switch (strategy) {
    case 'full-transcode': return 'software-main40-jp' as const;
    case 'direct': case 'remux': case 'audio-transcode': case 'video-transcode': return 'not-connected' as const;
  }
}
