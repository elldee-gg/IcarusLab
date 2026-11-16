import fs from 'node:fs';
import path from 'node:path';
import { startScheduler } from './backups.js';
import { ensureAdminPassword, ensureCertificates, ensureJwtSecret, ensurePhrase, lanAddresses, phrasePath, readPhraseFile } from './bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { repairStorage } from './repair.js';
import { createApp } from './server.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.storageDir, { recursive: true });

const db = openDatabase(path.join(config.dataDir, 'icarus.sqlite'));
const jwtSecret = ensureJwtSecret(config.dataDir);
ensureAdminPassword(db, config.adminPassword);
ensurePhrase(db, config.dataDir);
const tls = ensureCertificates(config.dataDir);

const app = { config, db, jwtSecret };
await repairStorage(db, config);
startScheduler(db, config);

const server = createApp(app, tls);
server.listen(config.port, config.host, () => {
  console.log('');
  console.log('IcarusLab is listening:');
  console.log(`  https://localhost:${config.port}`);
  for (const address of lanAddresses()) console.log(`  https://${address}:${config.port}`);
  console.log('');
  console.log(`Trust this certificate on each device: ${path.join(config.dataDir, 'ca.crt')}`);
  const phrase = readPhraseFile(config.dataDir);
  if (phrase) {
    console.log('');
    console.log('Admin recovery phrase. It stays the same across restarts. Save it somewhere safe.');
    console.log(phrase.trim());
    console.log(`A copy is in ${phrasePath(config.dataDir)} until the first successful admin login.`);
  }
  console.log('');
});
