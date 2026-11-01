// Browser side of WebAuthn (S35): converts the server's base64url options and the authenticator's answers. Needs navigator.credentials.

const toBuf = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64u = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const passkeysAvailable = () => typeof navigator !== "undefined" && !!navigator.credentials && typeof window !== "undefined" && !!window.PublicKeyCredential;

export async function createPasskey(o) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: toBuf(o.challenge),
      rp: o.rp,
      user: { id: toBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection,
      attestation: "none",
      timeout: o.timeout,
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ type: c.type, id: toBuf(c.id) })),
    },
  });
  return { id: toB64u(cred.rawId), clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject) };
}

export async function getPasskey(o) {
  const cred = await navigator.credentials.get({
    publicKey: { challenge: toBuf(o.challenge), rpId: o.rpId, userVerification: "required", timeout: o.timeout, allowCredentials: (o.allowCredentials || []).map((c) => ({ type: c.type, id: toBuf(c.id) })) },
  });
  return { id: toB64u(cred.rawId), clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData), signature: toB64u(cred.response.signature) };
}
