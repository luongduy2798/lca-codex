export interface LcaTokenAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
}

export class LcaTokenAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: LcaTokenAdapterErrorOptions) {
    super(message);
    this.name = "LcaTokenAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}
