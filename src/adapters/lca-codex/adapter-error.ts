export interface LcaCodexAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
}

export class LcaCodexAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: LcaCodexAdapterErrorOptions) {
    super(message);
    this.name = "LcaCodexAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}
