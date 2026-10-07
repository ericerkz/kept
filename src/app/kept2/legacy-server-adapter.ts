/**
 * TEMPORARY KEPT 2.0 LEGACY COMPATIBILITY LAYER.
 *
 * Supports the frozen Kept 1.8.1 protocol.
 * No new functionality may depend on this adapter.
 *
 * DELETE IN KEPT 2.1.
 */
export interface LegacyServerAdapter {
  readonly protocol: 'kept-1.8.1';
  readonly warningRequired: true;
  capabilities(): Promise<{ serverVersion: string; legacyRuntime: true }>;
}

