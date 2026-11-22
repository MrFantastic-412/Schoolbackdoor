/**
 * Privacy-first structured logger that redacts passwords, tokens, MFA secrets,
 * and private message contents before writing output.
 */

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|mfa_secret|cookie|privatekey|api_key|apikey|signature|message_text|private_message|^text$)/i;

export function redactSensitiveData(input: any, depth = 0): any {
  if (depth > 4 || input === null || input === undefined) {
    return input;
  }
  if (typeof input === 'string') {
    return input
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/data:image\/[a-z0-9+]+;base64,[a-zA-Z0-9+/=]{32,}/gi, '[REDACTED_BASE64_IMAGE]');
  }
  if (Array.isArray(input)) {
    return input.slice(0, 20).map((item) => redactSensitiveData(item, depth + 1));
  }
  if (typeof input === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveData(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

export const logger = {
  info(scope: string, message: string, meta?: any) {
    if (meta !== undefined) {
      console.log(`[${scope}] ${message}`, redactSensitiveData(meta));
    } else {
      console.log(`[${scope}] ${message}`);
    }
  },
  warn(scope: string, message: string, meta?: any) {
    if (meta !== undefined) {
      console.warn(`[${scope}] ${message}`, redactSensitiveData(meta));
    } else {
      console.warn(`[${scope}] ${message}`);
    }
  },
  error(scope: string, message: string, meta?: any) {
    if (meta !== undefined) {
      console.error(`[${scope}] ${message}`, redactSensitiveData(meta));
    } else {
      console.error(`[${scope}] ${message}`);
    }
  },
};
