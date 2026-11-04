'use strict';

const assert = require('node:assert/strict');
const {
  REVIEW_MIN_USAGE_SECONDS,
  PROMPT_COOLDOWN_MS,
  SNOOZE_MS,
  REVIEW_REPROMPT_MS,
  createReviewPrompt
} = require('../src/main/review-prompt.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (error) { results.push([false, name, error]); }
}

function fixture(initial = {}) {
  let clock = 1_700_000_000_000;
  let stored = { ...initial };
  const scheduler = createReviewPrompt({
    readJson: (_file, fallback) => stored || fallback,
    writeJson: (_file, value) => { stored = { ...value }; return true; },
    getVersion: () => '1.4.0',
    now: () => clock,
    random: () => 0,
    intervalMs: 60_000,
    log: { warn() {} }
  });
  return {
    scheduler,
    read: () => ({ ...stored }),
    write: (value) => { stored = { ...value }; },
    advance: (ms) => { clock += ms; },
    now: () => clock
  };
}

(async () => {
  await test('does not prompt before 30 minutes of accumulated application use', () => {
    const f = fixture();
    f.scheduler.start();
    f.advance(29 * 60 * 1000);
    const result = f.scheduler.maybePrompt();
    assert.equal(result.shouldPrompt, false);
    assert.equal(result.totalUsageSeconds, 29 * 60);
    assert.ok(result.nextCheckAfterMs > 0);
    f.scheduler.stop();
  });

  await test('qualifies after 30 minutes and exposes a randomized prompt decision', () => {
    const f = fixture();
    f.scheduler.start();
    f.advance(REVIEW_MIN_USAGE_SECONDS * 1000);
    const result = f.scheduler.maybePrompt();
    assert.equal(result.shouldPrompt, true);
    assert.equal(result.totalUsageSeconds, REVIEW_MIN_USAGE_SECONDS);
    assert.equal(result.nextCheckAfterMs, 0);
    f.scheduler.stop();
  });

  await test('persists usage across restarts', () => {
    const f = fixture();
    f.scheduler.start();
    f.advance(17 * 60 * 1000);
    f.scheduler.stop();
    assert.equal(f.read().totalUsageSeconds, 17 * 60);
    const restarted = createReviewPrompt({
      readJson: (_file, fallback) => f.read() || fallback,
      writeJson: (_file, value) => { f.write(value); return true; },
      getVersion: () => '1.4.0', now: f.now, random: () => 0, log: { warn() {} }
    });
    restarted.start();
    f.advance(13 * 60 * 1000);
    assert.equal(restarted.maybePrompt().shouldPrompt, true);
    restarted.stop();
  });

  await test('does not count time while the computer is suspended', () => {
    const f = fixture();
    f.scheduler.start();
    f.advance(10 * 60 * 1000);
    f.scheduler.pause();
    assert.equal(f.read().totalUsageSeconds, 10 * 60);
    f.advance(3 * 60 * 60 * 1000);
    f.scheduler.accountUsage();
    assert.equal(f.read().totalUsageSeconds, 10 * 60);
    f.scheduler.resume();
    f.advance(20 * 60 * 1000);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, true);
    f.scheduler.stop();
  });

  await test('remind me later snoozes for seven days', () => {
    const f = fixture({ totalUsageSeconds: REVIEW_MIN_USAGE_SECONDS });
    f.scheduler.defer('later');
    assert.equal(f.read().snoozedUntil, f.now() + SNOOZE_MS);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, false);
    f.advance(SNOOZE_MS + 1);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, true);
  });

  await test('do not ask again permanently stops automatic checks', () => {
    const f = fixture({ totalUsageSeconds: REVIEW_MIN_USAGE_SECONDS });
    f.scheduler.defer('never');
    assert.equal(f.read().neverAskAgain, true);
    assert.equal(f.scheduler.maybePrompt().stopChecking, true);
  });

  await test('prompt shown sets a seven-day anti-repeat cooldown', () => {
    const f = fixture({ totalUsageSeconds: REVIEW_MIN_USAGE_SECONDS });
    assert.equal(f.scheduler.markPromptShown(), true);
    assert.equal(f.read().promptCount, 1);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, false);
    assert.equal(f.scheduler.maybePrompt().nextCheckAfterMs, 24 * 60 * 60 * 1000);
  });

  await test('a submitted review rests for 90 days and requires 30 minutes of new use', () => {
    const f = fixture({ totalUsageSeconds: REVIEW_MIN_USAGE_SECONDS });
    f.scheduler.start();
    f.scheduler.markSubmitted();
    assert.equal(f.read().usageSecondsAtReview, REVIEW_MIN_USAGE_SECONDS);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, false);
    f.scheduler.stop();
    f.advance(REVIEW_REPROMPT_MS + 1);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, false);
    f.scheduler.start();
    f.advance(REVIEW_MIN_USAGE_SECONDS * 1000);
    assert.equal(f.scheduler.maybePrompt().shouldPrompt, true);
    f.scheduler.stop();
  });

  await test('new major version removes the 90-day wait but still needs fresh usage', () => {
    let clock = 1_700_000_000_000;
    let stored = { totalUsageSeconds: 1800, usageSecondsAtReview: 1800, submittedAt: clock, lastReviewVersion: '1.9.9' };
    const scheduler = createReviewPrompt({
      readJson: (_file, fallback) => stored || fallback,
      writeJson: (_file, value) => { stored = { ...value }; return true; },
      getVersion: () => '2.0.0', now: () => clock, random: () => 0, log: { warn() {} }
    });
    assert.equal(scheduler.maybePrompt().shouldPrompt, false);
    clock += REVIEW_MIN_USAGE_SECONDS * 1000;
    scheduler.start();
    // The session begins at the updated clock; accumulate another full 30 minutes.
    clock += REVIEW_MIN_USAGE_SECONDS * 1000;
    assert.equal(scheduler.maybePrompt().shouldPrompt, true);
    scheduler.stop();
  });

  const failed = results.filter(([ok]) => !ok);
  for (const [ok, name, error] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${error ? `\n${error.stack || error}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} review prompt tests passed.`);
  if (failed.length) process.exitCode = 1;
})();
