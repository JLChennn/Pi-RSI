// Trusted, fixed IPC program. Only this process inside Docker imports candidate code.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sourceHash = process.argv[3];
const compiledHash = createHash('sha256').update(readFileSync('/policy.mjs')).digest('hex');
const policy = await import('/policy.mjs');
if (typeof policy.decideRecovery !== 'function') throw new Error('Missing policy export');
const request = process.argv[2];
if (request === '--serve') { setInterval(() => {}, 100000); }
else if (request === '--attest') { console.log(JSON.stringify({ sourceHash, compiledHash })); }
else {
  if (!request || request.length > 12000) throw new Error('Oversized policy request');
  const data = JSON.parse(Buffer.from(request, 'base64').toString('utf8'));
  const f = data.failure;
  if (typeof data.requestId !== 'string' || !f || Object.keys(f).some(key =>
      !['errorCode', 'message', 'attempt', 'maxAttempts', 'retrySafe'].includes(key)) ||
      typeof f.errorCode !== 'string' || f.errorCode.length > 128 || typeof f.message !== 'string' || f.message.length > 2000 ||
      !Number.isInteger(f.attempt) || !Number.isInteger(f.maxAttempts) || f.attempt < 1 || f.maxAttempts < 1 ||
      typeof f.retrySafe !== 'boolean') throw new Error('Invalid policy input');
  const decision = policy.decideRecovery(Object.freeze(f));
  if (!decision || !['retry', 'stop'].includes(decision.action)) throw new Error('Invalid policy output');
  console.log(JSON.stringify({ requestId: data.requestId, sourceHash, compiledHash, action: decision.action }));
}
