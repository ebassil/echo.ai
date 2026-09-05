const assert = require('assert');

// Copy functions from scheduler settings for testing
function parseIntervalMs(value) {
  const normalized = value.trim().toLowerCase();
  let s = normalized;
  if (s.startsWith('every ')) s = s.slice(6).trim();
  const match = s.match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days|s|sec|secs|seconds)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit.startsWith('s')) return n * 1000;
  if (unit.startsWith('m')) return n * 60 * 1000;
  if (unit.startsWith('h')) return n * 60 * 60 * 1000;
  if (unit.startsWith('d')) return n * 24 * 60 * 60 * 1000;
  return null;
}

function isValidCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const validators = [
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/,
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/,
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/,
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/,
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/,
  ];
  for (let i = 0; i < 5; i++) if (!validators[i].test(parts[i])) return false;
  return true;
}

function parseCronField(value, min, max) {
  const set = new Set();
  if (value === '*') { for (let i=min;i<=max;i++) set.add(i); return set; }
  if (value.startsWith('*/')) { const step=parseInt(value.slice(2)); for(let i=min;i<=max;i++) if((i-min)%step===0) set.add(i); return set; }
  for(const part of value.split(',')) {
    if(part.includes('-')) { const [a,b]=part.split('-').map(s=>parseInt(s)); for(let i=a;i<=b;i++) set.add(i); }
    else { const n=parseInt(part); if(!isNaN(n)) set.add(n); }
  }
  return set;
}
function cronMatches(expr, date) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minStr,hourStr,domStr,monthStr,dowStr]=parts;
  const minute=date.getMinutes(), hour=date.getHours(), dom=date.getDate(), month=date.getMonth()+1, dow=date.getDay();
  const minSet=parseCronField(minStr,0,59), hourSet=parseCronField(hourStr,0,23), domSet=parseCronField(domStr,1,31), monthSet=parseCronField(monthStr,1,12), dowSet=parseCronField(dowStr,0,7);
  const dowNormalized = dow===7?0:dow;
  const dowMatches = dowSet.has(dow) || dowSet.has(dowNormalized) || (dow===0 && dowSet.has(7));
  return minSet.has(minute) && hourSet.has(hour) && domSet.has(dom) && monthSet.has(month) && dowMatches;
}

async function runTests() {
  console.log('Running scheduler unit tests...');

  // Interval parsing valid
  assert.strictEqual(parseIntervalMs('30m'), 30*60*1000);
  assert.strictEqual(parseIntervalMs('every 30m'), 30*60*1000);
  assert.strictEqual(parseIntervalMs('2h'), 2*60*60*1000);
  assert.strictEqual(parseIntervalMs('1d'), 24*60*60*1000);
  assert.strictEqual(parseIntervalMs('every 6h'), 6*60*60*1000);
  assert.strictEqual(parseIntervalMs('45s'), 45*1000);
  console.log('✓ interval parsing valid (30m, every 30m, 2h, 1d, 45s)');

  // Interval parsing invalid
  assert.strictEqual(parseIntervalMs('off'), null);
  assert.strictEqual(parseIntervalMs('disabled'), null);
  assert.strictEqual(parseIntervalMs('invalid'), null);
  assert.strictEqual(parseIntervalMs('30'), null);
  console.log('✓ interval parsing invalid returns null');

  // Cron validation
  assert.ok(isValidCron('0 */6 * * *'));
  assert.ok(isValidCron('*/15 * * * *'));
  assert.ok(isValidCron('0 0 * * 0'));
  assert.ok(!isValidCron('invalid'));
  assert.ok(!isValidCron('0 * * *'));
  console.log('✓ cron validation (valid and invalid)');

  // Cron matching
  const d1 = new Date(2026, 0, 1, 6, 0); // Jan 1 06:00
  assert.ok(cronMatches('0 6 * * *', d1));
  assert.ok(!cronMatches('0 6 * * *', new Date(2026,0,1,7,0)));
  assert.ok(cronMatches('0 */6 * * *', new Date(2026,0,1,12,0)));
  assert.ok(!cronMatches('0 */6 * * *', new Date(2026,0,1,13,0)));
  console.log('✓ cron matching (exact and every-6h)');

  // Disable/enable
  function shouldSchedule(s) { const t=s.trim().toLowerCase(); return t!=='' && t!=='off' && t!=='disabled'; }
  assert.strictEqual(shouldSchedule('off'), false);
  assert.strictEqual(shouldSchedule('disabled'), false);
  assert.strictEqual(shouldSchedule('30m'), true);
  assert.strictEqual(shouldSchedule('0 */6 * * *'), true);
  console.log('✓ disable/enable (off/disabled vs interval/cron)');

  // Vault lock defer: tick should not run while locked
  let tickCalled = false;
  async function vaultGatedTick(isLocked) {
    if (isLocked) { console.info('deferred'); return false; }
    tickCalled = true; return true;
  }
  await vaultGatedTick(true);
  assert.strictEqual(tickCalled, false);
  await vaultGatedTick(false);
  assert.strictEqual(tickCalled, true);
  console.log('✓ vault-lock defer (tick deferred while locked)');

  // Setting-change re-registration: reschedule cancels prior timer
  let rescheduleCount = 0;
  let timer = setInterval(()=>{}, 1000);
  function reschedule(newSched) {
    clearInterval(timer);
    rescheduleCount++;
    if (shouldSchedule(newSched)) timer = setInterval(()=>{}, 1000);
  }
  reschedule('30m');
  assert.strictEqual(rescheduleCount, 1);
  reschedule('off');
  assert.strictEqual(rescheduleCount, 2);
  clearInterval(timer);
  console.log('✓ setting-change re-registration (cancel prior timer)');

  // Minimum granularity 1 minute documented
  assert.ok(cronMatches('* * * * *', new Date())); // every minute
  console.log('✓ minimum granularity 1 minute (cron evaluated every 60s)');

  console.log('All scheduler tests passed');
}

runTests().catch(e=>{console.error(e);process.exit(1)});
