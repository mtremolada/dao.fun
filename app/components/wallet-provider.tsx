"use client";

/**
 * Universal wallet connection (one per app). Holds the connected
 * wallet-standard wallet, exposes a SignerLike for the browser-signing
 * seam (D-028), persists the choice so the session stays connected across
 * reloads, and owns the connect modal that every "Connect wallet"
 * affordance opens. No chain library enters the bundle — the same raw-byte
 * wallet-standard protocol the rest of the app uses.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connectWallet,
  disconnectWallet,
  onWalletChange,
  subscribeWallets,
  type StandardWalletLike,
  type WalletAccountLike,
} from "../lib/wallet-standard";
import { makeWalletSender, type WalletSender } from "../lib/wallet-sender";
import {
  allowedDetected,
  clearLastWalletName,
  loadLastWalletName,
  pickEagerWallet,
  saveLastWalletName,
} from "../lib/wallet-registry";
import { WalletModal } from "./wallet-modal";

export interface WalletContextValue {
  /** Every wallet-standard wallet currently registered in the page. */
  wallets: StandardWalletLike[];
  wallet: StandardWalletLike | null;
  account: WalletAccountLike | null;
  /** Display name of the connected wallet (e.g. "Phantom" or "Ledger"). */
  connectedName: string | null;
  /** Sender for the vote/deposit flows (wallet signs + broadcasts); null until connected. */
  sender: WalletSender | null;
  connecting: boolean;
  error: string | null;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  /** Connect to a specific registered wallet by name (modal selection). */
  connect: (walletName: string) => Promise<void>;
  /** Connect a Ledger hardware wallet over WebHID (Solana app). */
  connectLedger: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within <WalletProvider>");
  }
  return ctx;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<StandardWalletLike[]>([]);
  const [wallet, setWallet] = useState<StandardWalletLike | null>(null);
  const [account, setAccount] = useState<WalletAccountLike | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const [sender, setSender] = useState<WalletSender | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const eagerTried = useRef(false);
  const ledgerRef = useRef<{ disconnect: () => Promise<void> } | null>(null);

  // Live wallet-standard discovery, restricted to the supported wallets.
  useEffect(
    () => subscribeWallets((ws) => setWallets(allowedDetected(ws))),
    [],
  );

  const applyConnection = useCallback(
    (w: StandardWalletLike, acc: WalletAccountLike) => {
      setWallet(w);
      setAccount(acc);
      setConnectedName(w.name);
      setSender(makeWalletSender(w, acc));
      setError(null);
    },
    [],
  );

  const reset = useCallback(() => {
    setWallet(null);
    setAccount(null);
    setConnectedName(null);
    setSender(null);
  }, []);

  const connect = useCallback(
    async (walletName: string) => {
      const w = wallets.find((x) => x.name === walletName);
      if (!w) {
        setError(`wallet "${walletName}" is not available`);
        return;
      }
      setConnecting(true);
      setError(null);
      try {
        const acc = await connectWallet(w);
        applyConnection(w, acc);
        saveLastWalletName(w.name);
        setModalOpen(false);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setConnecting(false);
      }
    },
    [wallets, applyConnection],
  );

  const connectLedger = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const { connectLedger: doConnect } = await import("../lib/ledger");
      const res = await doConnect();
      setWallet(null);
      setAccount({ address: res.address });
      setConnectedName("Ledger");
      setSender(res.sender);
      ledgerRef.current = { disconnect: res.disconnect };
      // Hardware needs a fresh user gesture each session — do not persist for
      // silent reconnect.
      clearLastWalletName();
      setModalOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (wallet) await disconnectWallet(wallet);
    if (ledgerRef.current) {
      try {
        await ledgerRef.current.disconnect();
      } catch {
        /* transport already gone */
      }
      ledgerRef.current = null;
    }
    clearLastWalletName();
    reset();
  }, [wallet, reset]);

  // Stay connected across reloads: silently reconnect the last-used wallet
  // once it has registered. A silent connect never pops a window for an
  // already-trusted wallet; if it fails (locked / not trusted), stay logged
  // out without surfacing an error.
  useEffect(() => {
    if (eagerTried.current || wallet || wallets.length === 0) return;
    const target = pickEagerWallet(wallets, loadLastWalletName());
    if (!target) return; // not registered yet — retry when the list grows
    eagerTried.current = true;
    void (async () => {
      try {
        const acc = await connectWallet(target, { silent: true });
        applyConnection(target, acc);
      } catch {
        clearLastWalletName();
      }
    })();
  }, [wallets, wallet, applyConnection]);

  // Reflect external account switches / disconnects the wallet reports.
  useEffect(() => {
    if (!wallet) return;
    return onWalletChange(wallet, (props) => {
      const accounts = props.accounts;
      if (!accounts) return;
      if (accounts.length === 0) {
        clearLastWalletName();
        reset();
      } else if (accounts[0]) {
        applyConnection(wallet, accounts[0]);
      }
    });
  }, [wallet, applyConnection, reset]);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallets,
      wallet,
      account,
      connectedName,
      sender,
      connecting,
      error,
      modalOpen,
      openModal,
      closeModal,
      connect,
      connectLedger,
      disconnect,
    }),
    [
      wallets,
      wallet,
      account,
      connectedName,
      sender,
      connecting,
      error,
      modalOpen,
      openModal,
      closeModal,
      connect,
      connectLedger,
      disconnect,
    ],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      <WalletModal />
    </WalletContext.Provider>
  );
}
