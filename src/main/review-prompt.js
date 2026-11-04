'use strict';

/*
 * Usage-based review scheduling for Drift.
 *
 * The prompt is local-only: accumulated use, snooze state, and opt-out are stored in the
 * Drift profile. No browsing activity is read or transmitted. A review is requested only
 * after 30 minutes of accumulated application use, matching PDF Studio's review cadence.
 */

const STATE_FILE = 'review-prompt-state.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_MIN_USAGE_SECONDS = 30 * 60;
const PROMPT_COOLDOWN_MS = 7 * DAY_MS;
const SNOOZE_MS = 7 * DAY_MS;
const REVIEW_REPROMPT_MS = 90 * DAY_MS;
const MAX_USAGE_SECONDS = 315360000;

const DEFAULT_STATE = Object.freeze({
  totalUsageSeconds: 0,
  usageSecondsAtReview: 0,
  submittedAt: 0,
  lastReviewVersion: '',
  neverAskAgain: false,
  snoozedUntil: 0,
  lastPromptAt: 0,
  promptCount: 0
});

function majorOf(version) {
  const match = String(version || '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function normalizeState(saved) {
  const value = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return {
    totalUsageSeconds: Math.max(0, Math.min(MAX_USAGE_SECONDS, Math.floor(Number(value.totalUsageSeconds) || 0))),
    usageSecondsAtReview: Math.max(0, Math.min(MAX_USAGE_SECONDS, Math.floor(Number(value.usageSecondsAtReview) || 0))),
    submittedAt: Math.max(0, Number(value.submittedAt) || 0),
    lastReviewVersion: typeof value.lastReviewVersion === 'string' ? value.lastReviewVersion.slice(0, 32) : '',
    neverAskAgain: value.neverAskAgain === true,
    snoozedUntil: Math.max(0, Number(value.snoozedUntil) || 0),
    lastPromptAt: Math.max(0, Number(value.lastPromptAt) || 0),
    promptCount: Math.max(0, Math.min(10000, Math.floor(Number(value.promptCount) || 0)))
  };
}

function reviewCooldownRemainingMs(state, appVersion = '', now = Date.now()) {
  const submittedAt = Number(state?.submittedAt) || 0;
  if (submittedAt <= 0) return 0;
  if (appVersion && state.lastReviewVersion && majorOf(appVersion) > majorOf(state.lastReviewVersion)) return 0;
  return Math.max(0, REVIEW_REPROMPT_MS - Math.max(0, now - submittedAt));
}

function createReviewPrompt({ readJson, writeJson, getVersion = () => '', now = Date.now, random = Math.random, intervalMs = 60_000, log = console } = {}) {
  if (typeof readJson !== 'function' || typeof writeJson !== 'function') {
    throw new TypeError('Review prompt scheduler requires profile readJson and writeJson functions.');
  }

  let state = null;
  let sessionStartedAt = null;
  let lastAccountedAt = null;
  let usageTimer = null;

  function load() {
    if (state) return state;
    try { state = normalizeState(readJson(STATE_FILE, DEFAULT_STATE)); }
    catch (error) {
      // Do not block Drift startup if a local preference file cannot be read.
      log.warn('[Drift] Review prompt preferences could not be loaded:', error?.message || error);
      state = { ...DEFAULT_STATE };
    }
    return state;
  }

  function persist() {
    const current = load();
    const saved = writeJson(STATE_FILE, { ...current });
    if (saved === false) log.warn('[Drift] Review prompt preferences could not be saved.');
    return saved !== false;
  }

  function accountUsage() {
    const current = load();
    if (lastAccountedAt === null) return current.totalUsageSeconds;
    const timestamp = Number(now());
    const elapsedSeconds = Math.max(0, Math.floor((timestamp - lastAccountedAt) / 1000));
    if (elapsedSeconds < 1) return current.totalUsageSeconds;
    lastAccountedAt += elapsedSeconds * 1000;
    current.totalUsageSeconds = Math.min(MAX_USAGE_SECONDS, current.totalUsageSeconds + elapsedSeconds);
    persist();
    return current.totalUsageSeconds;
  }

  function start() {
    if (sessionStartedAt !== null) return false;
    const timestamp = Number(now());
    sessionStartedAt = timestamp;
    lastAccountedAt = timestamp;
    load();
    usageTimer = setInterval(accountUsage, Math.max(1000, Number(intervalMs) || 60_000));
    usageTimer.unref?.();
    return true;
  }

  function stop() {
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = null;
    if (lastAccountedAt !== null) accountUsage();
    sessionStartedAt = null;
    lastAccountedAt = null;
    persist();
    return true;
  }

  function pause() {
    if (lastAccountedAt === null) return false;
    accountUsage();
    lastAccountedAt = null;
    return true;
  }

  function resume() {
    if (sessionStartedAt === null || lastAccountedAt !== null) return false;
    lastAccountedAt = Number(now());
    return true;
  }

  function maybePrompt() {
    const current = load();
    const totalUsageSeconds = accountUsage();
    const timestamp = Number(now());
    const version = String(getVersion() || '');

    if (current.neverAskAgain) return { shouldPrompt: false, stopChecking: true, totalUsageSeconds };

    const reviewedCooldown = reviewCooldownRemainingMs(current, version, timestamp);
    if (reviewedCooldown > 0) {
      return { shouldPrompt: false, totalUsageSeconds, recentlyReviewed: true, nextCheckAfterMs: Math.min(DAY_MS, reviewedCooldown) };
    }

    if (timestamp < current.snoozedUntil) {
      return { shouldPrompt: false, totalUsageSeconds, nextCheckAfterMs: Math.min(DAY_MS, current.snoozedUntil - timestamp) };
    }

    if (current.lastPromptAt && timestamp - current.lastPromptAt < PROMPT_COOLDOWN_MS) {
      return { shouldPrompt: false, totalUsageSeconds, nextCheckAfterMs: Math.min(DAY_MS, PROMPT_COOLDOWN_MS - (timestamp - current.lastPromptAt)) };
    }

    // The first review requires 30 minutes total use. After a review, the user must
    // accumulate another 30 minutes of use before being asked for an updated rating.
    const usageSinceReview = Math.max(0, totalUsageSeconds - current.usageSecondsAtReview);
    const neededSeconds = Math.max(0, REVIEW_MIN_USAGE_SECONDS - usageSinceReview);
    if (totalUsageSeconds < REVIEW_MIN_USAGE_SECONDS || neededSeconds > 0) {
      const missing = Math.max(REVIEW_MIN_USAGE_SECONDS - totalUsageSeconds, neededSeconds);
      return {
        shouldPrompt: false,
        totalUsageSeconds,
        nextCheckAfterMs: Math.max(60_000, Math.min(10 * 60_000, missing * 1000 + random() * 20_000))
      };
    }

    // Stagger prompts across installations so everyone does not see one at the same time.
    const shouldPrompt = random() < 0.28;
    return {
      shouldPrompt,
      totalUsageSeconds,
      submitted: false,
      nextCheckAfterMs: shouldPrompt ? 0 : Math.round((12 + random() * 18) * 60_000)
    };
  }

  function markPromptShown() {
    const current = load();
    if (current.neverAskAgain) return false;
    current.lastPromptAt = Number(now());
    current.promptCount = Math.min(10000, current.promptCount + 1);
    persist();
    return true;
  }

  function defer(choice = 'later') {
    const current = load();
    if (String(choice) === 'never') {
      current.neverAskAgain = true;
      current.snoozedUntil = 0;
    } else {
      current.snoozedUntil = Number(now()) + SNOOZE_MS;
    }
    persist();
    return true;
  }

  function markSubmitted() {
    const current = load();
    accountUsage();
    current.submittedAt = Number(now());
    current.usageSecondsAtReview = current.totalUsageSeconds;
    current.lastReviewVersion = String(getVersion() || '').slice(0, 32);
    current.snoozedUntil = 0;
    persist();
    return true;
  }

  function snapshot() {
    return { ...load(), running: sessionStartedAt !== null };
  }

  return { start, stop, pause, resume, maybePrompt, markPromptShown, defer, markSubmitted, snapshot, accountUsage };
}

module.exports = {
  STATE_FILE,
  DAY_MS,
  REVIEW_MIN_USAGE_SECONDS,
  PROMPT_COOLDOWN_MS,
  SNOOZE_MS,
  REVIEW_REPROMPT_MS,
  DEFAULT_STATE,
  normalizeState,
  reviewCooldownRemainingMs,
  createReviewPrompt
};
