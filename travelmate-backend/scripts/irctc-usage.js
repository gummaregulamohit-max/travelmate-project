#!/usr/bin/env node
// Shows, and on explicit request resets, TravelMate's local count of Indian
// Railway IRCTC (RapidAPI) requests. Sends no request to any API.
//
//   npm run irctc:usage                      show the count, budget and blocks
//   npm run irctc:usage -- --reset --confirm start a new local budget period
//                                            (only when TRAIN_API_QUOTA_RESET_DATE
//                                            is unset — otherwise periods follow it)
//
// A reset only restarts TravelMate's own count (the old count is archived in
// the usage file's history). It does NOT renew your RapidAPI quota and is not
// treated as if it had: a 403/429 block, or RapidAPI's last "0 requests left"
// report, stays in force until its own reset time. Check your quota on the
// RapidAPI dashboard before resetting.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { requestBudgetStatus, startNewBudgetPeriod } = require('../src/services/irctc.service');

function show(status) {
  console.log(`Usage file:        ${status.file}${status.unreadable ? ' (UNREADABLE — live requests stay off)' : ''}`);
  console.log(`Live requests:     ${status.enabled ? 'on' : 'OFF'} (TRAIN_API_REQUEST_BUDGET=${status.budget})`);
  console.log(`Requests sent:     ${status.requestsSent} of ${status.budget} in this local period${status.period ? ` (started ${status.period.startedAt}, ${status.period.startedBy.replace(/_/g, ' ')})` : ''}`);
  console.log(`Quota period:      ${status.configuredPeriod ? `${status.configuredPeriod.start} to ${status.configuredPeriod.end} (TRAIN_API_QUOTA_RESET_DATE)` : 'not configured — the count restarts only by a manual reset'}`);
  if (status.resetDateMismatch) console.log(`WARNING:           RapidAPI reported its quota resets at ${status.provider.resetAt}, more than a day from the configured period end — check TRAIN_API_QUOTA_RESET_DATE.`);
  if (status.earlierPeriods) console.log(`Earlier periods:   ${status.earlierPeriods} (kept in the usage file)`);
  console.log(`RapidAPI reported: ${status.provider ? `${status.provider.remaining} left of ${status.provider.limit ?? '?'} at ${status.provider.observedAt}` : 'nothing yet'}`);
  console.log(`Blocked:           ${status.blockedUntil ? `yes (${status.blockReason}) until ${status.blockedUntil}` : 'no'}`);
}

const args = process.argv.slice(2);
if (!args.includes('--reset')) {
  show(requestBudgetStatus());
  process.exit(0);
}
if (!args.includes('--confirm')) {
  console.error('Refusing to reset without --confirm.\n' +
    'A reset only restarts TravelMate\'s local request count; it does not renew your RapidAPI quota.\n' +
    'Check the quota on the RapidAPI dashboard first, then run: npm run irctc:usage -- --reset --confirm');
  process.exit(1);
}
try {
  const status = startNewBudgetPeriod({ confirm: true, note: 'npm run irctc:usage -- --reset --confirm' });
  console.log('Started a new local budget period. Your RapidAPI quota itself is unchanged by this.');
  show(status);
  if (status.blockedUntil) console.log(`Note: requests stay blocked (${status.blockReason}) until ${status.blockedUntil} — a reset does not lift that.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
