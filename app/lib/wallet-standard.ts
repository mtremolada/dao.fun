/**
 * Minimal wallet-standard client (D-028). Implements the injected-wallet
 * discovery handshake and the two features the seam needs
 * ("standard:connect", "solana:signTransaction") directly against the
 * protocol — wallets exchange RAW transaction bytes, so no chain library
 * ever enters the client bundle. Phantom/Solflare/Backpack all register
 * through this same event protocol.
 */
import type { SignerLike } from "./governance-actions";

export interface WalletAccountLike {
  address: string;
}

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccountLike[] }>;
}

interface SignTransactionFeature {
  signTransaction(input: {
    transaction: Uint8Array;
    account: WalletAccountLike;
  }): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

export interface StandardWalletLike {
  name: string;
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

export async function connectWallet(
  wallet: StandardWalletLike,
): Promise<WalletAccountLike> {
  const connect = wallet.features["standard:connect"] as
    | ConnectFeature
    | undefined;
  if (connect) {
    const { accounts } = await connect.connect();
    if (accounts[0]) return accounts[0];
  }
  if (wallet.accounts[0]) return wallet.accounts[0];
  throw new Error(`wallet "${wallet.name}" exposed no accounts`);
}

/** Adapts a connected wallet-standard wallet to the flow's SignerLike. */
export function makeSigner(
  wallet: StandardWalletLike,
  account: WalletAccountLike,
): SignerLike {
  const feature = wallet.features["solana:signTransaction"] as
    | SignTransactionFeature
    | undefined;
  if (!feature) {
    throw new Error(`wallet "${wallet.name}" cannot sign transactions`);
  }
  return {
    address: account.address,
    async signTransaction(txBase64: string): Promise<string> {
      const [out] = await feature.signTransaction({
        transaction: base64ToBytes(txBase64),
        account,
      });
      if (!out) throw new Error("wallet returned no signed transaction");
      return bytesToBase64(out.signedTransaction);
    },
  };
}
