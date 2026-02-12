"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  API_BASE_PATH: () => API_BASE_PATH,
  DEFAULT_MAX_RETRIES: () => DEFAULT_MAX_RETRIES,
  DEFAULT_PAGE: () => DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE: () => DEFAULT_PAGE_SIZE,
  DEFAULT_TIMEOUT_MS: () => DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH: () => MAX_MESSAGE_LENGTH,
  MAX_PAGE_SIZE: () => MAX_PAGE_SIZE,
  MAX_SESSION_MESSAGES: () => MAX_SESSION_MESSAGES,
  MAX_SSE_CONNECTIONS_PER_ORG: () => MAX_SSE_CONNECTIONS_PER_ORG,
  MAX_SSE_CONNECTIONS_PER_USER: () => MAX_SSE_CONNECTIONS_PER_USER,
  RATE_LIMIT_PER_MINUTE_ORG: () => RATE_LIMIT_PER_MINUTE_ORG,
  RATE_LIMIT_PER_MINUTE_USER: () => RATE_LIMIT_PER_MINUTE_USER,
  RATE_LIMIT_WINDOW_MS: () => RATE_LIMIT_WINDOW_MS,
  RETRY_BACKOFF_MULTIPLIER: () => RETRY_BACKOFF_MULTIPLIER,
  RETRY_BASE_DELAY_MS: () => RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS: () => RETRY_MAX_DELAY_MS,
  SSE_CONNECTION_TIMEOUT_MS: () => SSE_CONNECTION_TIMEOUT_MS,
  SSE_HEARTBEAT_INTERVAL_MS: () => SSE_HEARTBEAT_INTERVAL_MS,
  SSE_HEARTBEAT_TIMEOUT_MS: () => SSE_HEARTBEAT_TIMEOUT_MS,
  SSE_MAX_RETRIES: () => SSE_MAX_RETRIES,
  SSE_RECONNECT_BASE_DELAY_MS: () => SSE_RECONNECT_BASE_DELAY_MS,
  SSE_RECONNECT_MAX_DELAY_MS: () => SSE_RECONNECT_MAX_DELAY_MS
});
module.exports = __toCommonJS(index_exports);
var SSE_HEARTBEAT_INTERVAL_MS = 3e4;
var SSE_CONNECTION_TIMEOUT_MS = 6e5;
var SSE_RECONNECT_BASE_DELAY_MS = 1e3;
var SSE_RECONNECT_MAX_DELAY_MS = 3e4;
var SSE_MAX_RETRIES = 5;
var SSE_HEARTBEAT_TIMEOUT_MS = 45e3;
var RATE_LIMIT_PER_MINUTE_USER = 300;
var RATE_LIMIT_PER_MINUTE_ORG = 3e3;
var RATE_LIMIT_WINDOW_MS = 6e4;
var DEFAULT_MAX_RETRIES = 3;
var RETRY_BASE_DELAY_MS = 1e3;
var RETRY_MAX_DELAY_MS = 1e4;
var RETRY_BACKOFF_MULTIPLIER = 2;
var DEFAULT_PAGE_SIZE = 20;
var MAX_PAGE_SIZE = 100;
var DEFAULT_PAGE = 1;
var MAX_MESSAGE_LENGTH = 1e5;
var MAX_SESSION_MESSAGES = 1e3;
var MAX_SSE_CONNECTIONS_PER_USER = 5;
var MAX_SSE_CONNECTIONS_PER_ORG = 50;
var API_BASE_PATH = "/api/v1";
var DEFAULT_TIMEOUT_MS = 3e4;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  API_BASE_PATH,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  MAX_PAGE_SIZE,
  MAX_SESSION_MESSAGES,
  MAX_SSE_CONNECTIONS_PER_ORG,
  MAX_SSE_CONNECTIONS_PER_USER,
  RATE_LIMIT_PER_MINUTE_ORG,
  RATE_LIMIT_PER_MINUTE_USER,
  RATE_LIMIT_WINDOW_MS,
  RETRY_BACKOFF_MULTIPLIER,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  SSE_CONNECTION_TIMEOUT_MS,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_HEARTBEAT_TIMEOUT_MS,
  SSE_MAX_RETRIES,
  SSE_RECONNECT_BASE_DELAY_MS,
  SSE_RECONNECT_MAX_DELAY_MS
});
