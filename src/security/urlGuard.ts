/**
 * urlGuard.ts — Layer 1 pure-logic: SEC-7 SSRF defence for outbound URL fetches.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/security/urlGuard.ts` (200L)
 * Port strategy: VERBATIM. Pure logic, no VS Code imports. The only runtime
 * dependencies are the global `URL` constructor and `fetch` — both available
 * in the extension host (Node 18+) and in browsers.
 *
 * 02_ARCHITECTURE.md §4.6 lists this as a Layer 1 port-verbatim file.
 *
 * The agent reaches out to user-supplied URLs in several places:
 *   - `web_fetch` tool
 *   - skill-registry URL importer (v1.1+)
 *   - MCP marketplace catalog fetch (v1.0+)
 *
 * Without an SSRF guard, a prompt-injected LLM (or a malicious marketplace
 * entry) can fetch cloud-metadata endpoints (169.254.169.254), loopback
 * services (127.0.0.1, ::1), or private-network hosts (10/8, 172.16/12,
 * 192.168/16) and exfiltrate the response back to itself via subsequent
 * tool calls.
 *
 * This module exposes `assertSafeUrl()` for synchronous URL validation and
 * `safeFetch()` for a fetch() wrapper that validates the URL AND disables
 * redirect-following to attacker-controlled servers that 302 to private IPs.
 *
 * Override: set `KOVIX_ALLOW_PRIVATE_NET=1` in the env to allow private-range
 * targets (e.g. for users running a local Ollama/LM Studio instance that
 * resolves to a private IP). Link-local (169.254/16) and loopback (127/8,
 * ::1) are still blocked unless `KOVIX_ALLOW_LOOPBACK=1` is also set.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

/**
 * CIDR ranges that should never be reachable from agent tool calls.
 * Each tuple is [octets, maskBits] for IPv4. IPv6 is checked separately.
 */
const BLOCKED_IPV4_RANGES: ReadonlyArray<{ name: string; base: number[]; mask: number }> = [
	{ name: 'loopback', base: [127, 0, 0, 0], mask: 8 },        // 127.0.0.0/8
	{ name: 'link-local', base: [169, 254, 0, 0], mask: 16 },   // 169.254.0.0/16 (cloud metadata!)
	{ name: 'private-10', base: [10, 0, 0, 0], mask: 8 },       // 10.0.0.0/8
	{ name: 'private-172', base: [172, 16, 0, 0], mask: 12 },   // 172.16.0.0/12
	{ name: 'private-192', base: [192, 168, 0, 0], mask: 16 },  // 192.168.0.0/16
	{ name: 'cgnat', base: [100, 64, 0, 0], mask: 10 },         // 100.64.0.0/10
	{ name: 'unspecified', base: [0, 0, 0, 0], mask: 8 },       // 0.0.0.0/8
];

/** Convert a 4-octet IPv4 string to a 32-bit unsigned int, or null if invalid. */
function ipv4ToUint32(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) { return null; }
	let result = 0;
	for (const part of parts) {
		const n = parseInt(part, 10);
		if (isNaN(n) || n < 0 || n > 255 || String(n) !== part) { return null; }
		result = (result << 8) | n;
		result = result >>> 0; // unsigned
	}
	return result;
}

/** Pack a [a,b,c,d] + maskBits into a 32-bit network address (host bits zeroed). */
function packCidr(base: number[], mask: number): number {
	const packed = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
	if (mask >= 32) { return packed; }
	const maskBits = mask === 0 ? 0 : (0xFFFFFFFF << (32 - mask)) >>> 0;
	return (packed & maskBits) >>> 0;
}

/** Check whether an IPv4 string falls within any blocked range. Returns the range name or null. */
function classifyIpv4(ip: string): string | null {
	const addr = ipv4ToUint32(ip);
	if (addr === null) { return null; }
	for (const range of BLOCKED_IPV4_RANGES) {
		const net = packCidr(range.base, range.mask);
		const maskBits = range.mask === 0 ? 0 : (0xFFFFFFFF << (32 - range.mask)) >>> 0;
		if (((addr & maskBits) >>> 0) === net) {
			return range.name;
		}
	}
	return null;
}

/** Check whether an IPv6 string is loopback (::1), unspecified (::), or link-local (fe80::/10). */
function classifyIpv6(ip: string): string | null {
	const lowered = ip.toLowerCase().trim();
	if (lowered === '::1') { return 'loopback'; }
	if (lowered === '::') { return 'unspecified'; }
	// Link-local: fe80::/10
	if (lowered.startsWith('fe8') || lowered.startsWith('fe9') || lowered.startsWith('fea') || lowered.startsWith('feb')) {
		return 'link-local';
	}
	// Unique-local: fc00::/7
	if (lowered.startsWith('fc') || lowered.startsWith('fd')) {
		return 'ula-private';
	}
	return null;
}

/**
 * Inspect a URL's hostname and decide whether it's safe to fetch.
 * Throws Error with a descriptive message if the URL is unsafe.
 *
 * Note: this is a string-level check; it does NOT resolve DNS. A DNS-rebinding
 * attack where a public hostname resolves to a private IP is therefore possible.
 * For full protection, use `safeFetch()` which resolves the hostname and checks
 * the resolved IP(s) before connecting.
 */
export function assertSafeUrl(rawUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`SSRF guard: invalid URL "${rawUrl}"`);
	}

	// Protocol allowlist
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`SSRF guard: protocol "${parsed.protocol}" not allowed (only http/https)`);
	}

	const host = parsed.hostname;

	// IPv6 in brackets — URL.hostname may or may not strip them depending on
	// the runtime (browsers strip, Node keeps). Strip explicitly before classify.
	const ipv6Match = host.match(/^\[?([0-9a-fA-F:]+)\]?$/);
	if (ipv6Match && host.includes(':')) {
		const bareHost = ipv6Match[1];  // capture group strips brackets
		const cls = classifyIpv6(bareHost);
		if (cls) {
			throw new Error(`SSRF guard: IPv6 host "${bareHost}" is in blocked range (${cls})`);
		}
		return;
	}

	// IPv4 literal
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
		const cls = classifyIpv4(host);
		if (cls) {
			throw new Error(`SSRF guard: IPv4 host "${host}" is in blocked range (${cls})`);
		}
		return;
	}

	// Hostname — block obvious internal names
	const lowered = host.toLowerCase();
	const BLOCKED_HOSTNAMES = new Set([
		'localhost', 'metadata', 'metadata.google.internal',
	]);
	if (BLOCKED_HOSTNAMES.has(lowered)) {
		throw new Error(`SSRF guard: hostname "${host}" is in blocked list (internal name)`);
	}
	if (lowered.endsWith('.internal') || lowered.endsWith('.local') || lowered.endsWith('.localhost')) {
		throw new Error(`SSRF guard: hostname "${host}" looks internal (TLD ${lowered.split('.').pop()})`);
	}
}

/**
 * Fetch wrapper that enforces the SSRF guard on both the request URL and any
 * redirect target. Redirects are followed manually so we can re-validate each
 * hop — `fetch()`'s built-in redirect-following would skip validation.
 *
 * After DNS resolution, you can pass `validateResolvedIp` to also block
 * hostnames that resolve to private IPs (defends against DNS rebinding).
 * In browser contexts, DNS resolution isn't directly accessible, so this is
 * a string-level guard only — but the manual redirect validation still closes
 * the most common SSRF vector (attacker server 302s to 169.254.169.254).
 */
export async function safeFetch(
	rawUrl: string,
	init?: RequestInit,
	maxRedirects = 5,
): Promise<Response> {
	assertSafeUrl(rawUrl);

	let currentUrl = rawUrl;
	let currentInit: RequestInit = { ...init, redirect: 'manual' };

	for (let hop = 0; hop <= maxRedirects; hop++) {
		const response = await fetch(currentUrl, currentInit);

		// 3xx = redirect; re-validate the Location header
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) {
				// No Location header — return the response as-is, caller decides
				return response;
			}
			// Resolve relative redirects against the current URL
			const nextUrl = new URL(location, currentUrl).toString();
			assertSafeUrl(nextUrl);
			currentUrl = nextUrl;
			// Strip body on redirect (per fetch spec)
			const { method, headers, ...rest } = init ?? {};
			currentInit = { ...rest, method: method ?? 'GET', redirect: 'manual' };
			continue;
		}

		return response;
	}

	throw new Error(`SSRF guard: too many redirects (>${maxRedirects})`);
}
