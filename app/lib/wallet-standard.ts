/**
 * Minimal wallet-standard client (D-028). Implements the injected-wallet
 * discovery handshake and the two features the seam needs
 * ("standard:connect", "solana:signTransaction") directly against the
 * protocol. Phantom/Solflare/Backpack all register through this same event
 * protocol. The signing/sending adapter lives in wallet-sender.ts.
 */

export interface WalletAccountLike {
  address: string;
}

interface ConnectFeature {
  /** `silent` lets a previously-authorized wallet reconnect with no popup. */
  connect(input?: {
    silent?: boolean;
  }): Promise<{ accounts: readonly WalletAccountLike[] }>;
}

interface DisconnectFeature {
  disconnect(): Promise<void>;
}

interface EventsFeature {
  on(event: "change", listener: (props: WalletChangeProps) => void): () => void;
}

export interface WalletChangeProps {
  accounts?: readonly WalletAccountLike[];
}

export interface StandardWalletLike {
  name: string;
  /** Data-URI the wallet ships for its own brand mark (wallet-standard). */
  icon?: string;
  version?: string;
  chains?: readonly string[];
  features: Record<string, unknown>;
  accounts: readonly WalletAccountLike[];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Discovery handshake: collect wallets already registered (they listen
 * for "wallet-standard:app-ready") and any that registered before us
 * (they dispatched "wallet-standard:register-wallet" at injection time
 * and re-call our api when we announce).
 */
export function discoverWallets(): StandardWalletLike[] {
  const wallets: StandardWalletLike[] = [];
  const api = {
    register: (...ws: StandardWalletLike[]) => {
      wallets.push(...ws);
      return () => {};
    },
  };
  window.addEventListener("wallet-standard:register-wallet", ((
    event: CustomEvent<(a: typeof api) => void>,
  ) => {
    event.detail(api);
  }) as EventListener);
  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", { detail: api }),
  );
  return wallets;
}

/**
 * Live discovery for the universal connect UI: keeps the
 * "wallet-standard:register-wallet" listener mounted so wallets injected
 * AFTER the app loads still appear, and announces "app-ready" once so
 * wallets injected before it register immediately. `onChange` fires with
 * the deduped (by reference, then by name) wallet list each time it grows.
 * Returns an unsubscribe that removes the listener.
 */
export function subscribeWallets(
  onChange: (wallets: StandardWalletLike[]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const found: StandardWalletLike[] = [];
  const api = {
    register: (...ws: StandardWalletLike[]) => {
      let changed = false;
      for (const w of ws) {
        if (found.includes(w)) continue;
        const sameName = found.findIndex((f) => f.name === w.name);
        if (sameName >= 0) {
          found[sameName] = w; // a re-registered wallet refreshes its entry
        } else {
          found.push(w);
        }
        changed = true;
      }
      if (changed) onChange([...found]);
      return () => {};
    },
  };
  const handler = ((event: CustomEvent<(a: typeof api) => void>) => {
    event.detail(api);
  }) as EventListener;
  window.addEventListener("wallet-standard:register-wallet", handler);
  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", { detail: api }),
  );
  onChange([...found]); // emit the initial (possibly empty) snapshot
  return () =>
    window.removeEventListener("wallet-standard:register-wallet", handler);
}

export async function connectWallet(
  wallet: StandardWalletLike,
  opts?: { silent?: boolean },
): Promise<WalletAccountLike> {
  const connect = wallet.features["standard:connect"] as
    | ConnectFeature
    | undefined;
  if (connect) {
    const { accounts } = await connect.connect(
      opts?.silent ? { silent: true } : undefined,
    );
    if (accounts[0]) return accounts[0];
  }
  if (wallet.accounts[0]) return wallet.accounts[0];
  throw new Error(`wallet "${wallet.name}" exposed no accounts`);
}

/** Best-effort disconnect — not all wallets expose the feature. */
export async function disconnectWallet(
  wallet: StandardWalletLike,
): Promise<void> {
  const feature = wallet.features["standard:disconnect"] as
    | DisconnectFeature
    | undefined;
  if (feature) {
    try {
      await feature.disconnect();
    } catch {
      // a wallet that refuses/declines disconnect must not wedge the UI
    }
  }
}

/**
 * Subscribe to a connected wallet's account/disconnect changes
 * ("standard:events"). Returns a no-op when the wallet does not implement
 * it. Lets the app reflect an external lock/switch without a refresh.
 */
export function onWalletChange(
  wallet: StandardWalletLike,
  listener: (props: WalletChangeProps) => void,
): () => void {
  const events = wallet.features["standard:events"] as EventsFeature | undefined;
  if (!events?.on) return () => {};
  try {
    return events.on("change", listener);
  } catch {
    return () => {};
  }
}
