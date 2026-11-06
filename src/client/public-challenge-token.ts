let active: { token: string; expires: number } | null = null;
export async function withAuthChallenge<T>(token: string, action: () => Promise<T>): Promise<T> {
  const current = { token, expires: Date.now() + 240_000 };
  active = current;
  try {
    return await action();
  } finally {
    if (active === current) active = null;
  }
}
export function authChallengeHeaders(url: string, headers?: HeadersInit) {
  const result = new Headers(headers);
  const path = new URL(url, window.location.origin).pathname;
  if (
    active &&
    active.expires > Date.now() &&
    ["/api/auth/sign-in/email", "/api/auth/sign-in/social", "/api/auth/passkey/generate-authenticate-options"].includes(
      path,
    )
  ) {
    result.set("x-turnstile-token", active.token);
    active = null;
  }
  return result;
}
