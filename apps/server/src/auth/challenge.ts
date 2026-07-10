import { createHash, randomBytes } from "node:crypto";

// state：一次性、随机、不可猜测，作为 login_challenges 主键。
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

// PKCE：code_verifier / code_challenge（S256）。仅 usesPkce 的 provider 用到。
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}
