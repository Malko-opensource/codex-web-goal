export type ConversationSurface = 'chrome-extension' | 'codex-inapp';

/**
 * A live, authenticated path to one rendered conversation surface.
 * Delivery semantics stay in Bridge; adapters only relay commands and observations.
 */
export interface ConversationSurfacePort {
  readonly surface: ConversationSurface;
  send(message: unknown): void;
  close(): void;
}
