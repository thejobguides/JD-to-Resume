import { z } from 'zod';

// Error envelope and codes (api-design.md §4).

export const ErrorCode = z.enum([
  'invalid_request',
  'unsupported_content',
  'unauthenticated',
  'token_expired',
  'session_revoked',
  'forbidden',
  'account_suspended',
  'not_found',
  'conflict',
  'payload_too_large',
  'processing_failed',
  'coupon_rejected',
  'extension_outdated',
  'rate_limited',
  'quota_exceeded',
  'concurrency_limit',
  'ai_unavailable',
  'maintenance',
  'step_up_required',
  'precondition_failed',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string().optional(),
    retryable: z.boolean().default(false),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unsupported_content: 400,
  unauthenticated: 401,
  token_expired: 401,
  session_revoked: 401,
  forbidden: 403,
  account_suspended: 403,
  step_up_required: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  processing_failed: 422,
  coupon_rejected: 422,
  extension_outdated: 426,
  rate_limited: 429,
  quota_exceeded: 429,
  concurrency_limit: 429,
  ai_unavailable: 503,
  maintenance: 503,
  internal: 500,
};

const RETRYABLE: Partial<Record<ErrorCode, boolean>> = {
  rate_limited: true,
  ai_unavailable: true,
  maintenance: true,
  internal: true,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
  }
  toEnvelope(requestId?: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { request_id: requestId } : {}),
        retryable: RETRYABLE[this.code] ?? false,
      },
    };
  }
}

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}
