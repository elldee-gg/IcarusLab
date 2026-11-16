import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import type { DatabaseSync } from 'node:sqlite';
import { writeAtomic } from './atomic.js';
import { randomBytes, sameBuffer, scryptHash } from './crypto.js';
import { metaGet, metaSet } from './db.js';
import { drawPhrase, normalizePhrase, phraseWordCount } from './wordlist.js';

export const PHRASE_FILE = 'admin-phrase.once.txt';

export function phrasePath(dataDir: string) {
  return path.join(dataDir, PHRASE_FILE);
}

export function readPhraseFile(dataDir: string) {
  const file = phrasePath(dataDir);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

export function ensureJwtSecret(dataDir: string) {
  const file = path.join(dataDir, 'jwt.secret');
  if (fs.existsSync(file) && fs.statSync(file).size === 32) return fs.readFileSync(file);
  const tmp = `${file}.tmp`;
  if (!fs.existsSync(file) && fs.existsSync(tmp) && fs.statSync(tmp).size === 32) {
    fs.renameSync(tmp, file);
    return fs.readFileSync(file);
  }
  writeAtomic(file, randomBytes(32));
  return fs.readFileSync(file);
}

export function ensureAdminPassword(db: DatabaseSync, password: string) {
  let saltHex = metaGet(db, 'admin_password_salt');
  if (!saltHex) {
    saltHex = randomBytes(16).toString('hex');
    metaSet(db, 'admin_password_salt', saltHex);
  }
  const hash = scryptHash(password, Buffer.from(saltHex, 'hex')).toString('hex');
  metaSet(db, 'admin_password_hash', hash);
  if (!metaGet(db, 'dummy_password_salt')) metaSet(db, 'dummy_password_salt', randomBytes(16).toString('hex'));
}

export function verifyAdminPassword(db: DatabaseSync, password: string) {
  const salt = metaGet(db, 'admin_password_salt');
  const hash = metaGet(db, 'admin_password_hash');
  if (!salt || !hash) return false;
  return sameBuffer(scryptHash(password, Buffer.from(salt, 'hex')), Buffer.from(hash, 'hex'));
}

export function storePhraseHash(db: DatabaseSync, phrase: string) {
  const salt = randomBytes(16);
  const hash = scryptHash(normalizePhrase(phrase), salt);
  metaSet(db, 'admin_phrase_salt', salt.toString('hex'));
  metaSet(db, 'admin_phrase_hash', hash.toString('hex'));
}

export function verifyPhrase(db: DatabaseSync, phrase: string) {
  const salt = metaGet(db, 'admin_phrase_salt');
  const hash = metaGet(db, 'admin_phrase_hash');
  if (!salt || !hash) return false;
  if (phraseWordCount(phrase) !== 12) return false;
  const got = scryptHash(normalizePhrase(phrase), Buffer.from(salt, 'hex'));
  return sameBuffer(got, Buffer.from(hash, 'hex'));
}

export function ensurePhrase(db: DatabaseSync, dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = phrasePath(dataDir);
  const hash = metaGet(db, 'admin_phrase_hash');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  if (!hash && !existing) {
    const phrase = drawPhrase(12);
    writeAtomic(file, `${phrase}\n`);
    storePhraseHash(db, phrase);
    return;
  }

  if (!hash && existing) {
    if (phraseWordCount(existing) !== 12) {
      fs.renameSync(file, `${file}.bad`);
      const phrase = drawPhrase(12);
      writeAtomic(file, `${phrase}\n`);
      storePhraseHash(db, phrase);
      return;
    }
    storePhraseHash(db, existing);
  }
}

export function consumePhraseFile(dataDir: string) {
  const file = phrasePath(dataDir);
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function lanAddresses() {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push(entry.address);
    }
  }
  return addresses;
}

function pemCert(cert: forge.pki.Certificate) {
  return forge.pki.certificateToPem(cert);
}

function pemKey(key: forge.pki.PrivateKey) {
  return forge.pki.privateKeyToPem(key);
}

export function ensureCertificates(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const caCertFile = path.join(dataDir, 'ca.crt');
  const caKeyFile = path.join(dataDir, 'ca.key');
  const certFile = path.join(dataDir, 'server.crt');
  const keyFile = path.join(dataDir, 'server.key');

  let caCertPem: string;
  let caKeyPem: string;
  if (fs.existsSync(caCertFile) && fs.existsSync(caKeyFile)) {
    caCertPem = fs.readFileSync(caCertFile, 'utf8');
    caKeyPem = fs.readFileSync(caKeyFile, 'utf8');
  } else {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [{ name: 'commonName', value: 'IcarusLab Local CA' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    caCertPem = pemCert(cert);
    caKeyPem = pemKey(keys.privateKey);
    writeAtomic(caKeyFile, caKeyPem);
    writeAtomic(caCertFile, caCertPem);
  }

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }

  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
  cert.setSubject([{ name: 'commonName', value: 'IcarusLab' }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames: { type: number; value?: string; ip?: string }[] = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    { type: 7, ip: '127.0.0.1' },
  ];
  for (const ip of lanAddresses()) altNames.push({ type: 7, ip });
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  writeAtomic(keyFile, pemKey(keys.privateKey));
  writeAtomic(certFile, pemCert(cert));
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}
