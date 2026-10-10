import { z } from 'zod';
import { ExtractedJob } from './job';

// Extension-internal message contracts (api-design.md §8). All messages: {type, v:1, requestId, payload}.

const Envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), v: z.literal(1), requestId: z.string().max(64), payload });

export const ExtractRequestMsg = Envelope('extract.request', z.object({ tabId: z.number().int(), frameIds: z.array(z.number().int()).optional() }));
export const ExtractFromSelectionMsg = Envelope(
  'extract.fromSelection',
  z.object({ text: z.string().max(20_000), pageUrl: z.string().max(2048).optional(), pageTitle: z.string().max(500).optional() }),
);
export const AuthChangedMsg = Envelope('auth.changed', z.object({ signedIn: z.boolean(), plan: z.string().optional() }));
export const ConfigUpdatedMsg = Envelope('config.updated', z.object({ version: z.number().int() }));

export const ExtensionMessage = z.discriminatedUnion('type', [ExtractRequestMsg, ExtractFromSelectionMsg, AuthChangedMsg, ConfigUpdatedMsg]);
export type ExtensionMessage = z.infer<typeof ExtensionMessage>;

export const ExtractResult = z.object({
  ok: z.boolean(),
  job: ExtractedJob.optional(),
  error: z.enum(['no_permission', 'restricted_page', 'timeout', 'not_found', 'invalid']).optional(),
});
export type ExtractResult = z.infer<typeof ExtractResult>;
