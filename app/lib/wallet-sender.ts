/**
 * Adapts a connected wallet-standard wallet into a sender. Preferred path is
 * "solana:signAndSendTransaction" — the wallet signs AND broadcasts through
 * ITS OWN RPC (exactly how a normal dapp works, no server of ours involved).
 * Falls back to "solana:signTransaction" + the read Connection's
 * sendRawTransaction for wallets that only sign.
 */
import bs58 from "bs58";
import type { Connection, Transaction } from "@solana/web3.js";
import type { StandardWalletLike, WalletAccountLike } from "./wallet-standard";
import { solanaChain } from "./solana";

export interface WalletSender {
  address: string;
  /** Signs and broadcasts; resolves to the base58 transaction signature. */
  signAndSend(tx: Transaction, connection: Connection): Promise<string>;
  /**
   * ed25519-sign an arbitrary message (off-chain), resolving the raw 64-byte
   * signature. Optional: not every wallet exposes it (e.g. Ledger over the
   * Solana app here). The enhanced-listing claim uses it so the payer proves
   * control of the paying wallet (D-037).
   */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

interface SignAndSendFeature {
  signAndSendTransaction(input: {
    transaction: Uint8Array;
    account: WalletAccountLike;
    chain: string;
  }): Promise<readonly { signature: Uint8Array }[]>;
}

interface SignTransactionFeature {
  signTransaction(input: {
    transaction: Uint8Array;
    account: WalletAccountLike;
  }): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

interface SignMessageFeature {
  signMessage(input: {
    message: Uint8Array;
    account: WalletAccountLike;
  }): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

function serialize(tx: Transaction): Uint8Array {
  return new Uint8Array(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
}

export function makeWalletSender(
  wallet: StandardWalletLike,
  account: WalletAccountLike,
): WalletSender {
  return {
    address: account.address,
    async signAndSend(tx, connection) {
      const transaction = serialize(tx);

      const sas = wallet.features["solana:signAndSendTransaction"] as
        | SignAndSendFeature
        | undefined;
      if (sas) {
        const [out] = await sas.signAndSendTransaction({
          transaction,
          account,
          chain: solanaChain(),
        });
        if (!out) throw new Error("wallet returned no signature");
        return bs58.encode(out.signature);
      }

      const st = wallet.features["solana:signTransaction"] as
        | SignTransactionFeature
        | undefined;
      if (!st) {
        throw new Error(`wallet "${wallet.name}" cannot sign transactions`);
      }
      const [signed] = await st.signTransaction({ transaction, account });
      if (!signed) throw new Error("wallet returned no signed transaction");
      return connection.sendRawTransaction(signed.signedTransaction, {
        skipPreflight: false,
      });
    },
    async signMessage(message) {
      const sm = wallet.features["solana:signMessage"] as
        | SignMessageFeature
        | undefined;
      if (!sm) {
        throw new Error(`wallet "${wallet.name}" cannot sign messages`);
      }
      const [out] = await sm.signMessage({ message, account });
      if (!out) throw new Error("wallet returned no signature");
      return out.signature;
    },
  };
}
