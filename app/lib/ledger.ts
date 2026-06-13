/**
 * Ledger (hardware) connector — Solana app over WebHID. Loaded only when the
 * user picks Ledger, so the transport never enters the main bundle or SSR.
 * The device signs; we broadcast through the read Connection (Ledger signs,
 * it does not send), keeping the "no server" model intact.
 */
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import type { WalletSender } from "./wallet-sender";

// BIP44 for Solana, account 0 — the path Phantom/Solflare use for Ledger.
const SOLANA_PATH = "44'/501'/0'";

export interface LedgerConnection {
  address: string;
  sender: WalletSender;
  disconnect: () => Promise<void>;
}

export async function connectLedger(): Promise<LedgerConnection> {
  if (typeof navigator === "undefined" || !("hid" in navigator)) {
    throw new Error(
      "This browser has no WebHID. Use Chrome or Edge, or connect your Ledger through Phantom/Solflare.",
    );
  }
  // Some Ledger libs expect a global Buffer; provide it defensively.
  const g = globalThis as { Buffer?: unknown };
  if (!g.Buffer) g.Buffer = (await import("buffer")).Buffer;

  const [{ default: TransportWebHID }, { default: Solana }] = await Promise.all([
    import("@ledgerhq/hw-transport-webhid"),
    import("@ledgerhq/hw-app-solana"),
  ]);

  const transport = await TransportWebHID.request();
  const app = new Solana(transport);

  let pubkey: PublicKey;
  try {
    const { address } = await app.getAddress(SOLANA_PATH);
    pubkey = new PublicKey(address);
  } catch {
    await transport.close();
    throw new Error(
      "Could not read the Solana address — unlock your Ledger and open the Solana app, then try again.",
    );
  }

  const sender: WalletSender = {
    address: pubkey.toBase58(),
    async signAndSend(tx: Transaction, connection: Connection) {
      const message = tx.serializeMessage();
      const { signature } = await app.signTransaction(SOLANA_PATH, message);
      tx.addSignature(pubkey, signature);
      return connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
    },
  };

  return {
    address: pubkey.toBase58(),
    sender,
    disconnect: () => transport.close(),
  };
}
