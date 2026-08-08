export const metadata = { title: "Disclaimer — dao.fun" };

export default function DisclaimerPage() {
  return (
    <div className="card" style={{ maxWidth: 640, margin: "2rem auto" }}>
      <h1>Disclaimer</h1>
      <p className="muted">
        dao.fun is experimental demo software running on Solana Devnet. Coins
        launched here are testnet tokens with <strong>no monetary value</strong>{" "}
        and cannot be bought or sold for real funds.
      </p>
      <p className="muted">
        Nothing on this site is an offer, solicitation, or investment advice.
        The software is provided as-is, without warranty. Devnet state may be
        reset at any time.
      </p>
      <p className="muted">
        You are responsible for the wallet you connect and the transactions you
        approve. Set your wallet to Solana Devnet before trading.
      </p>
    </div>
  );
}
