/**
 * Injected-provider connect for Phantom/Solflare — the battle-tested path
 * (window.phantom.solana / window.solflare). The wallet-standard `connect`
 * can throw Phantom's internal -32603 "Unexpected error" in some setups
 * (solana-foundation/solana-web3.js#3267); the injected provider is what
 * production dapps use and it natively signs AND sends. No server.
 */
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import type { WalletSender } from "./wallet-sender";
import type { SigningWallet } from "./tx-sender";

export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: {
    onlyIfTrusted?: boolean;
  }): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signAndSendTransaction?(
    tx: Transaction,
  ): Promise<{ signature: string } | string>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
}

function injectedWindow(): Record<string, unknown> | undefined {
  return typeof window !== "undefined"
    ? (window as unknown as Record<string, unknown>)
    : undefined;
}

/** The injected Solana provider for a supported wallet, if present. */
export function injectedProvider(name: string): SolanaProvider | undefined {
  const w = injectedWindow();
  if (!w) return undefined;
  if (name === "Phantom") {
    const phantom = (w["phantom"] as { solana?: SolanaProvider } | undefined)
      ?.solana;
    if (phantom?.isPhantom) return phantom;
    const sol = w["solana"] as SolanaProvider | undefined;
    if (sol?.isPhantom) return sol;
    return undefined;
  }
  if (name === "Solflare") {
    const sf = w["solflare"] as SolanaProvider | undefined;
    if (sf?.isSolflare) return sf;
    return undefined;
  }
  return undefined;
}

/**
 * The send pipeline's signer, built from an INJECTED provider.
 *
 * Phantom/Solflare connect through their injected provider (the reliable
 * path — see the -32603 note above), which leaves us without a
 * wallet-standard account object, so the wallet-standard adapter cannot be
 * used for these connections. Exposing both capabilities here lets the
 * pipeline keep its devnet rule: sign only, and WE broadcast to our own rpc.
 */
export function signingWalletFromProvider(
  provider: SolanaProvider,
  address: string,
): SigningWallet {
  void new PublicKey(address); // validate up front
  const out: SigningWallet = { address };
  if (typeof provider.signTransaction === "function") {
    out.signOnly = async (tx: Transaction) => {
      const signed = await provider.signTransaction!(tx);
      return new Uint8Array(signed.serialize());
    };
  }
  if (typeof provider.signAndSendTransaction === "function") {
    out.signAndSend = async (tx: Transaction) => {
      const r = await provider.signAndSendTransaction!(tx);
      return typeof r === "string" ? r : r.signature;
    };
  }
  return out;
}

export function senderFromProvider(
  provider: SolanaProvider,
  address: string,
): WalletSender {
  // validate the address up front
  void new PublicKey(address);
  return {
    address,
    async signAndSend(tx: Transaction, connection: Connection) {
      if (typeof provider.signAndSendTransaction === "function") {
        const r = await provider.signAndSendTransaction(tx);
        return typeof r === "string" ? r : r.signature;
      }
      if (typeof provider.signTransaction === "function") {
        const signed = await provider.signTransaction(tx);
        return connection.sendRawTransaction(signed.serialize());
      }
      throw new Error(`${address} cannot sign transactions`);
    },
  };
}

export interface InjectedConnection {
  address: string;
  sender: WalletSender;
  provider: SolanaProvider;
}

export async function connectInjected(
  name: string,
  opts?: { silent?: boolean },
): Promise<InjectedConnection> {
  const provider = injectedProvider(name);
  if (!provider) throw new Error(`${name} is not installed`);
  const resp = await provider.connect(
    opts?.silent ? { onlyIfTrusted: true } : undefined,
  );
  const pk = resp?.publicKey ?? provider.publicKey;
  if (!pk) throw new Error(`${name} did not return a public key`);
  const address = pk.toString();
  return { address, sender: senderFromProvider(provider, address), provider };
}
