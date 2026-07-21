export type CliErrorCategory = 'auth' | 'config' | 'internal' | 'protocol' | 'resolution';

const EXIT_CODES: Record<CliErrorCategory, number> = {
  auth: 4,
  config: 2,
  internal: 1,
  protocol: 5,
  resolution: 3,
};

export class CliError extends Error {
  readonly code: string;
  readonly category: CliErrorCategory;
  readonly details?: unknown;
  readonly remediation?: { command: string };

  constructor(input: {
    code: string;
    message: string;
    category: CliErrorCategory;
    details?: unknown;
    remediation?: { command: string };
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'CliError';
    this.code = input.code;
    this.category = input.category;
    this.details = input.details;
    this.remediation = input.remediation;
  }

  get exitCode(): number {
    return EXIT_CODES[this.category];
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError({
    category: 'internal',
    code: 'INTERNAL_ERROR',
    message,
    cause: error,
  });
}
