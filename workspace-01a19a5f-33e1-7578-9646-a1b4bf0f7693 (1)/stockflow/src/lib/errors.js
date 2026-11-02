'use strict';

/** Wraps any raw driver error into an HTTP-friendly ApiError. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function httpError(status, code, message, details) {
  return new ApiError(status, code, message, details);
}

/** async route wrapper — forwards thrown errors to the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const nowIso = () => new Date().toISOString();

const toNumber = (value, fallback = 0) => {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const toInt = (value, fallback = 0) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

/** Escapes a string for safe use inside a SQL LIKE pattern. */
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

module.exports = { ApiError, httpError, asyncHandler, nowIso, toNumber, round2, toInt, isEmail, likeEscape };
