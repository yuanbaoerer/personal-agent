export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class FeishuAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuAuthError";
  }
}

export class FeishuRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuRequestError";
  }
}

/** The platform may have accepted the request; the local side did not observe it. */
export class DeliveryUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeliveryUnknownError";
  }
}

/** The platform rejected the request, or it was never sent. */
export class DeliveryRejectedError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeliveryRejectedError";
    this.retryable = retryable;
  }
}
