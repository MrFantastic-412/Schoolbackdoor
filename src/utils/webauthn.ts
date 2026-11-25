import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

export function isPasskeySupported(): boolean {
  try {
    return typeof window !== 'undefined' && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export function formatPasskeyError(err: any, fallback: string): string {
  const code = String(err?.code || '');
  const name = String(err?.name || '');
  const msg = String(err?.message || '');

  if (
    name === 'NotAllowedError' ||
    name === 'AbortError' ||
    code === 'ERROR_CEREMONY_ABORTED' ||
    /not allowed|timed out|aborted|cancelled|canceled/i.test(msg)
  ) {
    return 'Passkey prompt was cancelled or timed out. You can try again or use your password instead.';
  }

  if (
    name === 'InvalidStateError' ||
    code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
  ) {
    return 'This device or security key already has a passkey saved for this account.';
  }

  if (
    name === 'SecurityError' ||
    /securityerror|relying party|rp id|https|domain|origin/i.test(msg)
  ) {
    return 'Passkeys require HTTPS and a matching site domain. Please use password sign-in here.';
  }

  if (
    name === 'NotSupportedError' ||
    code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY'
  ) {
    return 'Passkeys are not supported on this browser or device. Use your @username and password instead.';
  }

  return msg || fallback;
}
