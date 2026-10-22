/**
 * A mail change the provider will never accept, such as a move to a folder
 * that is gone. The operation is rejected for good instead of retried.
 */
export class ProviderChangeRejectedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Provider rejected the change: ${code}`);
    this.name = "ProviderChangeRejectedError";
    this.code = code;
  }
}
