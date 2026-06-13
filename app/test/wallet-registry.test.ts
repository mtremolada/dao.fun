/**
 * Universal wallet connect — pure logic (written alongside the components).
 * Covers persistence of the last wallet (the "stays connected" guarantee),
 * the eager-reconnect pick, display formatting, the install-list filter,
 * and the live wallet-standard discovery handshake — all offline.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowedDetected,
  clearLastWalletName,
  installOptions,
  loadLastWalletName,
  pickEagerWallet,
  saveLastWalletName,
  slugify,
  truncateAddress,
} from "../lib/wallet-registry";
import { subscribeWallets, type StandardWalletLike } from "../lib/wallet-standard";

function wallet(name: string): StandardWalletLike {
  return { name, accounts: [], features: {} };
}

describe("display + slug helpers", () => {
  it("truncates long addresses, leaves short ones alone", () => {
    expect(truncateAddress("GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR")).toBe(
      "GRdk…t8wR",
    );
    expect(truncateAddress("short")).toBe("short");
  });

  it("slugifies wallet names for stable testids/keys", () => {
    expect(slugify("E2E Fake Wallet")).toBe("e2e-fake-wallet");
    expect(slugify("Coinbase Wallet")).toBe("coinbase-wallet");
    expect(slugify("  Glow!  ")).toBe("glow");
  });
});

describe("supported-wallet allowlist (Phantom only)", () => {
  it("keeps only Phantom among detected wallets", () => {
    const names = allowedDetected([
      wallet("Phantom"),
      wallet("Backpack"),
      wallet("Solflare"),
      wallet("Glow"),
    ]).map((w) => w.name);
    expect(names).toEqual(["Phantom"]);
  });

  it("offers a Phantom install link only when it is not detected", () => {
    expect(installOptions([wallet("phantom")])).toEqual([]);
    const opts = installOptions([]);
    expect(opts.map((o) => o.name)).toEqual(["Phantom"]);
    expect(opts[0]!.url.startsWith("https://")).toBe(true);
  });
});

describe("eager reconnect pick", () => {
  const wallets = [wallet("Phantom"), wallet("Solflare")];
  it("returns the stored wallet once it is registered", () => {
    expect(pickEagerWallet(wallets, "Solflare")?.name).toBe("Solflare");
  });
  it("returns nothing when there is no stored name or it is absent", () => {
    expect(pickEagerWallet(wallets, null)).toBeUndefined();
    expect(pickEagerWallet(wallets, "Backpack")).toBeUndefined();
  });
});

describe("last-wallet persistence", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["localStorage"];
  });

  it("round-trips and clears the last wallet name", () => {
    expect(loadLastWalletName()).toBeNull();
    saveLastWalletName("Phantom");
    expect(loadLastWalletName()).toBe("Phantom");
    clearLastWalletName();
    expect(loadLastWalletName()).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    delete (globalThis as Record<string, unknown>)["localStorage"];
    expect(() => saveLastWalletName("x")).not.toThrow();
    expect(loadLastWalletName()).toBeNull();
  });
});

describe("subscribeWallets — live discovery", () => {
  let win: EventTarget;
  beforeEach(() => {
    win = new EventTarget();
    (globalThis as Record<string, unknown>)["window"] = win;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["window"];
  });

  function registerLater(w: StandardWalletLike) {
    win.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", {
        detail: (api: { register: (...ws: StandardWalletLike[]) => void }) =>
          api.register(w),
      }),
    );
  }

  it("discovers app-ready wallets, then late ones, dedupes by name, and unsubscribes cleanly", () => {
    const phantom = wallet("Phantom");
    // Phantom is already injected: it answers app-ready.
    win.addEventListener("wallet-standard:app-ready", ((
      e: CustomEvent<{ register: (...ws: StandardWalletLike[]) => void }>,
    ) => e.detail.register(phantom)) as EventListener);

    const updates: string[][] = [];
    const unsub = subscribeWallets((ws) => updates.push(ws.map((w) => w.name)));
    expect(updates.at(-1)).toEqual(["Phantom"]);

    // Solflare injects after the app loaded -> register-wallet event.
    registerLater(wallet("Solflare"));
    expect(updates.at(-1)).toEqual(["Phantom", "Solflare"]);

    // A duplicate name does not grow the list.
    registerLater(wallet("Solflare"));
    expect(updates.at(-1)!.filter((n) => n === "Solflare")).toHaveLength(1);

    // After unsubscribe, further registrations are ignored.
    unsub();
    const seen = updates.length;
    registerLater(wallet("Backpack"));
    expect(updates).toHaveLength(seen);
  });
});
