/**
 * Account decoders, by byte offset (deliberately — a layout change surfaces
 * as a failing offset). Matches the on-chain `Config` and `BondingCurve`
 * struct order in programs/launchpad-curve/src/lib.rs.
 */
import { PublicKey } from "@solana/web3.js";

export interface DecodedConfig {
  authority: PublicKey;
  feeRecipient: PublicKey;
  protocolFeeBps: number;
  creatorFeeBps: number;
  graduationFeeLamports: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  initialRealToken: bigint;
  tokenTotalSupply: bigint;
  cpmmProgram: PublicKey;
  cpmmAmmConfig: PublicKey;
  cpmmCreatePoolFee: PublicKey;
  bump: number;
  /** Raydium's locker; all-zero means migrate BURNS the LP (devnet). */
  lockProgram: PublicKey;
  /** Protocol share of the SOL side of graduated fees, after recovery. */
  graduatedFeeProtocolBps: number;
}

export function decodeConfig(data: Buffer | Uint8Array): DecodedConfig {
  const d = Buffer.from(data);
  return {
    authority: new PublicKey(d.subarray(8, 40)),
    feeRecipient: new PublicKey(d.subarray(40, 72)),
    protocolFeeBps: d.readUInt16LE(72),
    creatorFeeBps: d.readUInt16LE(74),
    graduationFeeLamports: d.readBigUInt64LE(76),
    initialVirtualSol: d.readBigUInt64LE(84),
    initialVirtualToken: d.readBigUInt64LE(92),
    initialRealToken: d.readBigUInt64LE(100),
    tokenTotalSupply: d.readBigUInt64LE(108),
    cpmmProgram: new PublicKey(d.subarray(116, 148)),
    cpmmAmmConfig: new PublicKey(d.subarray(148, 180)),
    cpmmCreatePoolFee: new PublicKey(d.subarray(180, 212)),
    bump: d[212]!,
    lockProgram: new PublicKey(d.subarray(213, 245)),
    graduatedFeeProtocolBps: d.readUInt16LE(245),
  };
}

/** True when the config selects the lock branch (mainnet) over burning. */
export const configLocksLiquidity = (cfg: DecodedConfig): boolean =>
  !cfg.lockProgram.equals(PublicKey.default);

export interface DecodedCurve {
  mint: PublicKey;
  creator: PublicKey;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
  complete: boolean;
  migrated: boolean;
  poolState: PublicKey;
}

export function decodeCurve(data: Buffer | Uint8Array): DecodedCurve {
  const d = Buffer.from(data);
  return {
    mint: new PublicKey(d.subarray(8, 40)),
    creator: new PublicKey(d.subarray(40, 72)),
    virtualSol: d.readBigUInt64LE(72),
    virtualToken: d.readBigUInt64LE(80),
    realSol: d.readBigUInt64LE(88),
    realToken: d.readBigUInt64LE(96),
    protocolFeeBps: d.readUInt16LE(104),
    creatorFeeBps: d.readUInt16LE(106),
    complete: d[108] === 1,
    migrated: d[109] === 1,
    poolState: new PublicKey(d.subarray(110, 142)),
  };
}
