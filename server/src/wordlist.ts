import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// words.txt is the BIP-39 English wordlist (MIT), from https://github.com/bitcoin/bips
let words: string[] | null = null;

export function wordlist() {
  if (words) return words;
  const file = path.join(import.meta.dirname, 'words.txt');
  words = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#'));
  if (words.length < 1000) throw new Error('The passphrase wordlist is incomplete');
  return words;
}

export function drawPhrase(count = 12) {
  const list = wordlist();
  const picked: string[] = [];
  for (let i = 0; i < count; i += 1) picked.push(list[crypto.randomInt(0, list.length)]!);
  return picked.join(' ');
}

export function normalizePhrase(input: string) {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export function phraseWordCount(input: string) {
  const normalized = normalizePhrase(input);
  return normalized ? normalized.split(' ').length : 0;
}
