// Writes .dev.vars (the local secret `wrangler dev` reads) from a service account JSON key file,
// so the key never has to be copied by hand.
// Usage: node scripts/dev-vars.mjs .secrets/service-account.json
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/dev-vars.mjs <service-account-key.json>');
  process.exit(1);
}
const key = JSON.parse(readFileSync(file, 'utf8'));
if (!key.client_email || !key.private_key) {
  console.error('That file is not a service account key (no client_email / private_key).');
  process.exit(1);
}
// Single quotes keep the JSON (including its \n escapes) literal.
writeFileSync('.dev.vars', `GOOGLE_SERVICE_ACCOUNT='${JSON.stringify(key)}'\n`);
console.log('Wrote .dev.vars for ' + key.client_email);
