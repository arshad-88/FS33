'use strict';
/*
 * Tests for server/urlscan.js — the guarded URL scanner route.
 *
 * Every dangerous destination pattern the scanner must refuse is tested
 * directly against isForbiddenIp. Live-server route tests and
 * outbound-network tests are kept behind guards so CI stays deterministic.
 */

const test = require('node:test');
const assert = require('node:assert');

const urlscan = require('../urlscan');
const { isForbiddenIp } = urlscan;

test('isForbiddenIp: loopback', () => {
  assert.strictEqual(isForbiddenIp('127.0.0.1'), true);
  assert.strictEqual(isForbiddenIp('127.1.2.3'), true);
});

test('isForbiddenIp: RFC1918 private ranges', () => {
  assert.strictEqual(isForbiddenIp('10.0.0.1'), true);
  assert.strictEqual(isForbiddenIp('10.255.255.255'), true);
  assert.strictEqual(isForbiddenIp('172.16.0.1'), true);
  assert.strictEqual(isForbiddenIp('172.31.255.255'), true);
  assert.strictEqual(isForbiddenIp('192.168.1.1'), true);
});

test('isForbiddenIp: link-local and cloud metadata', () => {
  assert.strictEqual(isForbiddenIp('169.254.0.1'), true);
  assert.strictEqual(isForbiddenIp('169.254.169.254'), true);
});

test('isForbiddenIp: CGNAT, multicast, reserved, this-network', () => {
  assert.strictEqual(isForbiddenIp('100.64.0.1'), true);
  assert.strictEqual(isForbiddenIp('224.0.0.1'), true);
  assert.strictEqual(isForbiddenIp('239.255.255.255'), true);
  assert.strictEqual(isForbiddenIp('0.0.0.0'), true);
  assert.strictEqual(isForbiddenIp('250.1.2.3'), true);
});

test('isForbiddenIp: IPv6 loopback, ULA, link-local, mapped-IPv4', () => {
  assert.strictEqual(isForbiddenIp('::1'), true);
  assert.strictEqual(isForbiddenIp('::'), true);
  assert.strictEqual(isForbiddenIp('fe80::1'), true);
  assert.strictEqual(isForbiddenIp('fd00::1'), true);
  assert.strictEqual(isForbiddenIp('fc00::1'), true);
  assert.strictEqual(isForbiddenIp('::ffff:127.0.0.1'), true);
  assert.strictEqual(isForbiddenIp('::ffff:10.0.0.5'), true);
  assert.strictEqual(isForbiddenIp('::ffff:169.254.169.254'), true);
});

test('isForbiddenIp: real public IPs are allowed', () => {
  assert.strictEqual(isForbiddenIp('8.8.8.8'), false);
  assert.strictEqual(isForbiddenIp('1.1.1.1'), false);
  assert.strictEqual(isForbiddenIp('172.32.0.1'), false); // just outside 172.16/12
  assert.strictEqual(isForbiddenIp('192.169.0.1'), false); // just outside 192.168/16
});

test('assertPublicHost rejects loopback targets (SSRF)', async () => {
  await assert.rejects(
    () => urlscan.assertPublicHost('localhost'),
    (err) => err && err.code === 'scan_forbidden_target'
  );
});

test('assertPublicHost rejects literal IPv4 private', async () => {
  await assert.rejects(
    () => urlscan.assertPublicHost('10.1.2.3'),
    (err) => err && err.code === 'scan_forbidden_target'
  );
});

test('assertPublicHost rejects metadata hostname', async () => {
  await assert.rejects(
    () => urlscan.assertPublicHost('metadata.google.internal'),
    (err) => err && err.code === 'scan_forbidden_target'
  );
});

/* Outbound-network test: only runs with FS_TEST_INTERNET=1. */
test('assertPublicHost accepts a public domain (internet)', { skip: process.env.FS_TEST_INTERNET !== '1' }, async () => {
  const addrs = await urlscan.assertPublicHost('example.com');
  assert.ok(Array.isArray(addrs) && addrs.length > 0);
});
