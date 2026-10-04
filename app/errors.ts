// FW-17: the site's 500 path. The server's own console line is redacted like every other console line: the error is
// redacted deeply (message, stack, cause and extra properties) before it is logged. The response body is { error }
// and goes through send(), which deep-redacts every JSON body.
import { redactDeep } from '../sdk/redact.js';

export function serverError(e: unknown, log: (...a: unknown[]) => void = console.error): { error: string } {
  log(redactDeep(e));
  return { error: String((e as any)?.message ?? e) };
}
