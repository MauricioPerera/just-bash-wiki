/**
 * Pin DNS resolution for the actual fetch to the IPs that were validated
 * by the preflight private-range check, defeating DNS rebinding.
 *
 * How it works:
 * - `dns.lookup` is monkey-patched once globally to consult an
 *   AsyncLocalStorage store. When called inside a `pinDns(...)` async
 *   context for the same hostname, it returns the pre-validated address
 *   without performing any network DNS query.
 * - Calls outside any pinning context (or for a different hostname)
 *   are delegated to the original `dns.lookup`.
 *
 * Why `dns.lookup` and not `dns.promises.lookup`:
 * - Node's `net.connect`/`tls.connect` (used by undici under `globalThis.fetch`)
 *   reads `dns.lookup` at call time and uses the callback form.
 * - We do not patch the promises form because it's not on the connect path.
 *
 * Browser builds: this module is imported transitively from `fetch.ts`
 * (re-exported via `just-bash/browser`). `node:dns` is aliased to a
 * stub by the browser build, but `node:async_hooks` cannot be aliased
 * via a static import. We therefore lazy-load both via `require()`
 * inside an `IS_BROWSER === false` guard so esbuild can dead-code
 * eliminate the Node-only path. In the browser the exported `pinDns`
 * is a passthrough that just runs the callback (the preflight that
 * would have produced a `PinnedAddress` always throws first because
 * `node:dns` is unavailable, so the passthrough is unreachable).
 */
export interface PinnedAddress {
    hostname: string;
    address: string;
    family: 4 | 6;
}
/**
 * Run `fn` with `dns.lookup` for `pinned.hostname` resolving to
 * `pinned.address`/`pinned.family`. Resolutions for other hostnames
 * pass through to the original `dns.lookup`.
 */
export declare function pinDns<T>(pinned: PinnedAddress, fn: () => Promise<T>): Promise<T>;
/**
 * @internal Exposed for tests to verify the patched dns.lookup behaves
 * correctly inside and outside a pinning context.
 */
export declare function _ensureDnsHookInstalled(): void;
