/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { isPrivateIp } from '../../../src/handlers/shared/resolve-url-attachments';

describe('isPrivateIp', () => {
  describe('IPv4 private ranges', () => {
    test('blocks 10.x.x.x (RFC 1918 Class A)', () => {
      expect(isPrivateIp('10.0.0.1')).toBeDefined();
      expect(isPrivateIp('10.255.255.255')).toBeDefined();
    });

    test('blocks 172.16-31.x.x (RFC 1918 Class B)', () => {
      expect(isPrivateIp('172.16.0.1')).toBeDefined();
      expect(isPrivateIp('172.31.255.255')).toBeDefined();
    });

    test('allows 172.15.x.x and 172.32.x.x (outside RFC 1918)', () => {
      expect(isPrivateIp('172.15.0.1')).toBeUndefined();
      expect(isPrivateIp('172.32.0.1')).toBeUndefined();
    });

    test('blocks 192.168.x.x (RFC 1918 Class C)', () => {
      expect(isPrivateIp('192.168.0.1')).toBeDefined();
      expect(isPrivateIp('192.168.255.255')).toBeDefined();
    });

    test('blocks 169.254.x.x (link-local)', () => {
      expect(isPrivateIp('169.254.169.254')).toBeDefined(); // AWS metadata
      expect(isPrivateIp('169.254.0.1')).toBeDefined();
    });

    test('blocks 127.x.x.x (loopback)', () => {
      expect(isPrivateIp('127.0.0.1')).toBeDefined();
      expect(isPrivateIp('127.255.255.255')).toBeDefined();
    });

    test('blocks 0.x.x.x (current network)', () => {
      expect(isPrivateIp('0.0.0.0')).toBeDefined();
      expect(isPrivateIp('0.1.2.3')).toBeDefined();
    });

    test('blocks 100.64.x.x (CGN / RFC 6598)', () => {
      expect(isPrivateIp('100.64.0.1')).toBeDefined();
      expect(isPrivateIp('100.64.255.255')).toBeDefined();
    });

    test('allows public IPv4 addresses', () => {
      expect(isPrivateIp('8.8.8.8')).toBeUndefined();
      expect(isPrivateIp('1.1.1.1')).toBeUndefined();
      expect(isPrivateIp('203.0.113.1')).toBeUndefined();
      expect(isPrivateIp('100.63.255.255')).toBeUndefined(); // Just below CGN
    });
  });

  describe('IPv6 private ranges', () => {
    test('blocks ::1 (loopback)', () => {
      expect(isPrivateIp('::1')).toBeDefined();
    });

    test('blocks :: (unspecified address)', () => {
      expect(isPrivateIp('::')).toBeDefined();
    });

    test('blocks fc/fd prefixes (ULA)', () => {
      expect(isPrivateIp('fc00::1')).toBeDefined();
      expect(isPrivateIp('fd12:3456:789a::1')).toBeDefined();
    });

    test('blocks fe80: (link-local)', () => {
      expect(isPrivateIp('fe80::1')).toBeDefined();
      expect(isPrivateIp('fe80::abcd:ef01')).toBeDefined();
    });

    test('blocks IPv4-mapped IPv6 (::ffff:x.x.x.x)', () => {
      expect(isPrivateIp('::ffff:169.254.169.254')).toBeDefined();
      expect(isPrivateIp('::ffff:10.0.0.1')).toBeDefined();
      expect(isPrivateIp('::ffff:127.0.0.1')).toBeDefined();
    });

    test('blocks expanded IPv4-mapped IPv6 (0:0:0:0:0:ffff:x)', () => {
      expect(isPrivateIp('0:0:0:0:0:ffff:169.254.169.254')).toBeDefined();
    });

    test('allows public IPv6 addresses', () => {
      expect(isPrivateIp('2001:4860:4860::8888')).toBeUndefined(); // Google DNS
      expect(isPrivateIp('2606:4700:4700::1111')).toBeUndefined(); // Cloudflare DNS
    });
  });

  describe('case insensitivity', () => {
    test('handles uppercase IPv6', () => {
      expect(isPrivateIp('FC00::1')).toBeDefined();
      expect(isPrivateIp('FE80::1')).toBeDefined();
      expect(isPrivateIp('::FFFF:10.0.0.1')).toBeDefined();
    });
  });
});
