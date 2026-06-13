/**
 * The chain reader now lives in the SDK (D-033) so it runs in both the keyed
 * backend and the browser. This module re-exports it unchanged; the backend
 * HTTP layer, tests, and dashboards keep importing from "./chain-reader".
 */
export * from "@daofun/sdk/chain-reader";
