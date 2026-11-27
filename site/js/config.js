// Phase 0 switches. Flip these when billing launches; the file format already carries
// every field, so no format change is needed.
export const PHASE0 = {
  /** Everything is free while the project is in Phase 0. */
  billingEnabled: false,
  /**
   * Bind free (UNLICENSED) files to the creating device (encrypted with a key that never
   * leaves this browser). Temporarily OFF in Phase 0: free files open on any device,
   * but are still marked "unlicensed".
   */
  bindFreeFilesToDevice: false,
};
