import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeSecretFile } from "./secure-file.mjs";

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(buf) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function addressFromSpkiDer(der) {
  const digest = crypto.createHash("sha256").update(der).digest().subarray(0, 20);
  return `ag1-${base32(digest)}`;
}

const derLen = (n) => {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  while (n) {
    b.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const oid = (s) => {
  const parts = s.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const enc = [n & 0x7f];
    n >>= 7;
    while (n) {
      enc.unshift(0x80 | (n & 0x7f));
      n >>= 7;
    }
    bytes.push(...enc);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const integer = (b) => {
  let buf = Buffer.from(b);
  while (buf.length > 1 && buf[0] === 0 && buf[1] < 0x80) buf = buf.subarray(1);
  if (buf[0] >= 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const bitString = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utcTime = (s) => tlv(0x17, Buffer.from(s, "ascii"));
const generalizedTime = (s) => tlv(0x18, Buffer.from(s, "ascii"));
const explicit = (n, inner) => tlv(0xa0 + n, inner);

export function makeSelfSignedCert(address, privateKey, publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const algId = seq(oid("1.3.101.112"));
  const cnName = seq(set(seq(oid("2.5.4.3"), utf8(address))));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algId,
    cnName,
    seq(utcTime("000101000000Z"), generalizedTime("20991231235959Z")),
    cnName,
    spki
  );
  const signature = crypto.sign(null, tbs, privateKey);
  const cert = seq(tbs, algId, bitString(signature));
  const b64 = cert.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n+$/, "");
  return { pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, der: cert };
}

const identityCache = new Map();

export function loadIdentity(bridgeRoot) {
  const root = path.resolve(bridgeRoot);
  const cached = identityCache.get(root);
  if (cached) return cached;

  const filePath = path.join(root, "identity.json");
  let privatePem;
  let publicPem;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof raw?.privatePem === "string" && typeof raw?.publicPem === "string") {
      privatePem = raw.privatePem;
      publicPem = raw.publicPem;
    }
  } catch {
    // 首次使用或文件损坏时重新生成
  }
  if (!privatePem || !publicPem) {
    const pair = crypto.generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
    fs.mkdirSync(root, { recursive: true });
    writeSecretFile(filePath, JSON.stringify({ privatePem, publicPem }, null, 2) + "\n");
  }

  const privateKey = crypto.createPrivateKey(privatePem);
  const publicKey = crypto.createPublicKey(publicPem);
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const address = addressFromSpkiDer(spkiDer);
  const cert = makeSelfSignedCert(address, privateKey, publicKey);

  const identity = {
    address,
    privateKey,
    publicKey,
    privatePem,
    publicPem,
    spkiDer,
    certPem: cert.pem,
    certDer: cert.der
  };
  identityCache.set(root, identity);
  return identity;
}
