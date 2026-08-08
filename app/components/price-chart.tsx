"use client";

/**
 * Candlestick + volume chart on TradingView's lightweight-charts (v5 API,
 * loaded dynamically so it never runs during SSR/prerender). Data comes in as
 * plain OHLCV candles; `mode` switches between SOL price per token and market
 * cap (price × the fixed 1B whole-token supply — every coin on this
 * deployment shares it), which keeps devnet numbers readable.
 */
import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/launchpad-api";

export type ChartMode = "price" | "mcap";
const WHOLE_TOKEN_SUPPLY = 1_000_000_000; // 1e15 base units at 6 decimals

interface ChartHandles {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
}

export function PriceChart({ candles, mode }: { candles: Candle[]; mode: ChartMode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const { createChart, CandlestickSeries, HistogramSeries } = await import("lightweight-charts");
      const el = containerRef.current;
      if (disposed || !el) return;
      const chart = createChart(el, {
        height: 380,
        autoSize: false,
        width: el.clientWidth,
        layout: {
          background: { color: "transparent" },
          textColor: "#8b949e",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(48, 54, 61, 0.5)" },
          horzLines: { color: "rgba(48, 54, 61, 0.5)" },
        },
        rightPriceScale: { borderColor: "#30363d" },
        timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
      });
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#2ea043",
        downColor: "#f85149",
        wickUpColor: "#2ea043",
        wickDownColor: "#f85149",
        borderVisible: false,
      });
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      observer = new ResizeObserver(() => {
        chart.applyOptions({ width: el.clientWidth });
      });
      observer.observe(el);
      handlesRef.current = { chart, candles: candleSeries, volume: volumeSeries };
      setReady(true);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      handlesRef.current?.chart.remove();
      handlesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const h = handlesRef.current;
    if (!ready || !h) return;
    const scale = mode === "mcap" ? WHOLE_TOKEN_SUPPLY : 1;
    h.candles.applyOptions({
      priceFormat:
        mode === "mcap"
          ? { type: "price", precision: 2, minMove: 0.01 }
          : { type: "price", precision: 10, minMove: 1e-10 },
    });
    h.candles.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open * scale,
        high: c.high * scale,
        low: c.low * scale,
        close: c.close * scale,
      })),
    );
    h.volume.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "rgba(46, 160, 67, 0.45)" : "rgba(248, 81, 73, 0.45)",
      })),
    );
    h.chart.timeScale().fitContent();
  }, [candles, mode, ready]);

  return (
    <div className="chart-wrap" data-testid="price-chart">
      <div ref={containerRef} />
      {candles.length === 0 && (
        <div className="chart-empty muted">No trades yet — the chart draws from the first trade.</div>
      )}
    </div>
  );
}
