import Link from "next/link";

export default function NotFound() {
  return (
    <section className="hero" style={{ textAlign: "center" }}>
      <h1>
        <span className="gradient-text">404</span>
      </h1>
      <p className="hero-sub" style={{ margin: "0.5rem auto 1.5rem" }}>
        That page drifted off-chain. The DAO, proposal, and dashboard views are
        deep links — head back and start from a governance mode.
      </p>
      <div className="hero-cta" style={{ justifyContent: "center" }}>
        <Link className="button" href="/">
          Back to dao.fun
        </Link>
      </div>
    </section>
  );
}
