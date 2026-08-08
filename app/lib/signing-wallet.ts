/**
 * Adapts a connected wallet-standard wallet into the `SigningWallet` the send
 * pipeline consumes. Exposes BOTH capabilities when the wallet has them:
 * sign-only (the deterministic devnet path — we broadcast to our RPC) and
 * sign-and-send (the wallet broadcasts on its own network — mainnet/fallback).
 */
import bs58 from "bs58";
import type { Transaction } from "@solana/web3.js";
import type { StandardWalletLike, WalletAccountLike } from "./wallet-standard";
import type { SigningWallet } from "./tx-sender";
import { chainId } from "./cluster";

interface SignTransactionFeature {
  signTransaction(input: {
    transaction: Uint8Array;
    account: WalletAccountLike;
  }): Promise<readonly { signedTransaction: Uint8Array }[]>;
}
interface SignAndSendFeature {
  signAndSendTransaction(input: {
    transaction: Uint8Array;
    account: WalletAccountLike;
    chain: string;
  }): Promise<readonly { signature: Uint8Array }[]>;
}

function serialize(tx: Transaction): Uint8Array {
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

export function makeSigningWallet(
  wallet: StandardWalletLike,
  account: WalletAccountLike & { chains?: readonly string[] },
): SigningWallet {
  const st = wallet.features["solana:signTransaction"] as SignTransactionFeature | undefined;
  const sas = wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature | undefined;

  const out: SigningWallet = {
    address: account.address,
    chains: account.chains ?? wallet.chains,
  };
  if (st) {
    out.signOnly = async (tx: Transaction) => {
      const [signed] = await st.signTransaction({ transaction: serialize(tx), account });
      if (!signed) throw new Error("wallet returned no signed transaction");
      return signed.signedTransaction;
    };
  }
  if (sas) {
    out.signAndSend = async (tx: Transaction) => {
      const [res] = await sas.signAndSendTransaction({
        transaction: serialize(tx),
        account,
        chain: chainId(),
      });
      if (!res) throw new Error("wallet returned no signature");
      return bs58.encode(res.signature);
    };
  }
  return out;
}
