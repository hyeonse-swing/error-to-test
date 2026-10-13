const URL_PATTERN = /(?:\bhttps?:\/\/|(?<!:)\/\/)[^\s<>"']+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JSON_SECRET = /(["'])(authorization|auth|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|passcode|pin|otp|secret|cookie|session[_-]?id)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[\s\S])*?\4/gi;
const JSON_SECRET_SCALAR = /(["'])(authorization|auth|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|passcode|pin|otp|secret|cookie|session[_-]?id)\1(\s*:\s*)(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*[,}\]])/gi;
const SECRET = /\b(authorization|auth|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|passcode|pin|otp|secret|cookie|session[_-]?id)\s*[:=]\s*(?:["']?)(?:Bearer\s+)?[^\s,;"']+/gi;
const STANDALONE_TOKEN = /\b(?:gh[oprsu]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;

export function safeUrl(value: string): string {
  try {
    const url = value.startsWith('//') ? new URL(value, 'https://placeholder.invalid/') : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[redacted-url]';
    return `${url.origin}${redactTextWithoutUrls(url.pathname)}`;
  } catch {
    if (value.startsWith('//')) return '[redacted-url]';
    const path = value.split(/[?#]/, 1)[0] ?? '';
    return redactTextWithoutUrls(path);
  }
}

function redactTextWithoutUrls(value: string): string {
  return value
    .replace(PRIVATE_KEY, '[redacted-private-key]')
    .replace(JSON_SECRET, '$1$2$1$3$4[redacted]$4')
    .replace(JSON_SECRET_SCALAR, '$1$2$1$3"[redacted]"')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(SECRET, '$1=[redacted]')
    .replace(STANDALONE_TOKEN, '[redacted-token]')
    .replace(EMAIL, '[redacted-email]');
}

export function redactText(value: string): string {
  return redactTextWithoutUrls(value.replace(URL_PATTERN, (match) => safeUrl(match)));
}

export function pagePath(value?: string): string {
  if (!value) return '';
  try {
    const url = value.startsWith('//') ? new URL(value, 'https://placeholder.invalid/') : new URL(value);
    return redactTextWithoutUrls(url.pathname || '/');
  } catch {
    if (value.startsWith('//')) return '[redacted-path]';
    return redactTextWithoutUrls((value.split(/[?#]/, 1)[0] ?? '').replace(/^https?:\/\/[^/]+/i, '') || '/');
  }
}
