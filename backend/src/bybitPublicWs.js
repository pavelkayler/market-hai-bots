// backend/src/bybitPublicWs.js
import WebSocket from "ws";

const DEFAULT_URL = "wss://stream.bybit.com/v5/public/linear";

// Bybit V5 public ticker topic: tickers.{symbol}
// Docs: topic uses snapshot + delta; missing fields in delta mean "unchanged".
export function createBybitPublicWs({
                                        url = DEFAULT_URL,
                                        symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
                                        logger = console,
                                        onStatus = () => {},
                                        onTicker = () => {},
                                    } = {}) {
    let ws = null;

    let status = "disconnected"; // disconnected | connecting | connected
    let desiredSymbols = uniqSymbols(symbols);
    let subscribedTopics = new Set();

    // raw state per symbol for snapshot/delta merge
    const rawTickerState = new Map(); // symbol -> merged raw ticker
    const normalizedState = new Map(); // symbol -> normalized ticker

    let reconnectTimer = null;
    let pingTimer = null;
    let backoffMs = 1000;

    function setStatus(next) {
        if (status === next) return;
        status = next;
        onStatus({ status, url, desiredSymbols });
    }

    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        clearTimers();
        setStatus("connecting");

        ws = new WebSocket(url);

        ws.on("open", () => {
            backoffMs = 1000;
            subscribedTopics = new Set();
            setStatus("connected");

            // subscribe current desired
            subscribeSymbols(desiredSymbols);

            // Bybit recommends sending ping periodically to keep alive (every ~20s)
            pingTimer = setInterval(() => {
                safeSend({ op: "ping" });
            }, 20000);
        });

        ws.on("message", (buf) => {
            let msg;
            try {
                msg = JSON.parse(buf.toString("utf8"));
            } catch {
                return;
            }

            // pong / ack
            if (msg.op === "pong") return;

            // ticker stream
            if (typeof msg.topic === "string" && msg.topic.startsWith("tickers.")) {
                const symbol = msg.topic.slice("tickers.".length);
                const type = msg.type; // "snapshot" | "delta"
                const data = msg.data;

                if (!symbol || !data) return;

                // merge snapshot/delta
                const prev = rawTickerState.get(symbol) || {};
                const merged =
                    type === "snapshot"
                        ? { ...data }
                        : { ...prev, ...data };

                rawTickerState.set(symbol, merged);

                const normalized = normalizeTicker(merged, {
                    src: "bybit",
                    symbol,
                    receivedAt: Date.now(),
                    bybitTs: typeof msg.ts === "number" ? msg.ts : null,
                });

                normalizedState.set(symbol, normalized);
                onTicker(normalized);
                return;
            }
        });

        ws.on("close", () => {
            setStatus("disconnected");
            scheduleReconnect();
        });

        ws.on("error", (err) => {
            logger?.warn?.("[bybit ws] error:", err?.message || err);
            // close will trigger reconnect
        });
    }

    function scheduleReconnect() {
        clearTimers();
        if (reconnectTimer) return;

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            backoffMs = Math.min(backoffMs * 2, 15000);
            connect();
        }, backoffMs);
    }

    function clearTimers() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
    }

    function safeSend(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(obj));
            return true;
        } catch {
            return false;
        }
    }

    function topicForSymbol(sym) {
        return `tickers.${sym}`;
    }

    function subscribeSymbols(syms) {
        const topics = syms.map(topicForSymbol);
        const newTopics = topics.filter((t) => !subscribedTopics.has(t));
        if (newTopics.length === 0) return;

        // official op format: { op: "subscribe", args: ["tickers.BTCUSDT", ...] }
        safeSend({ op: "subscribe", args: newTopics });
        newTopics.forEach((t) => subscribedTopics.add(t));
    }

    function unsubscribeSymbols(syms) {
        const topics = syms.map(topicForSymbol);
        const oldTopics = topics.filter((t) => subscribedTopics.has(t));
        if (oldTopics.length === 0) return;

        // V5 supports unsubscribe (many clients use it)
        safeSend({ op: "unsubscribe", args: oldTopics });
        oldTopics.forEach((t) => subscribedTopics.delete(t));
    }

    function setSymbols(nextSymbols) {
        const next = uniqSymbols(nextSymbols);
        const prev = desiredSymbols;

        desiredSymbols = next;

        // diff
        const toUnsub = prev.filter((s) => !next.includes(s));
        const toSub = next.filter((s) => !prev.includes(s));

        if (ws && ws.readyState === WebSocket.OPEN) {
            unsubscribeSymbols(toUnsub);
            subscribeSymbols(toSub);
        } else {
            connect();
        }

        onStatus({ status, url, desiredSymbols });
    }

    function getStatus() {
        return { status, url, desiredSymbols };
    }

    function getSymbols() {
        return [...desiredSymbols];
    }

    function getTickers() {
        // plain object for JSON
        const out = {};
        for (const [sym, t] of normalizedState.entries()) out[sym] = t;
        return out;
    }

    function close() {
        clearTimers();
        try {
            ws?.close?.();
        } catch {}
        ws = null;
        setStatus("disconnected");
    }

    // start immediately
    connect();

    return {
        connect,
        close,
        setSymbols,
        getStatus,
        getSymbols,
        getTickers,
    };
}

function uniqSymbols(input) {
    const arr = Array.isArray(input) ? input : [];
    const cleaned = arr
        .map((s) => (typeof s === "string" ? s.trim().toUpperCase() : ""))
        .filter(Boolean)
        // normalize "BTC/USDT" -> "BTCUSDT"
        .map((s) => s.replace("/", "").replace("-", ""));
    return [...new Set(cleaned)];
}

function num(x) {
    if (x === null || x === undefined) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

function normalizeTicker(raw, meta) {
    return {
        src: meta.src,
        symbol: meta.symbol,
        receivedAt: meta.receivedAt,
        bybitTs: meta.bybitTs,

        // core prices
        last: num(raw.lastPrice),
        bid: num(raw.bid1Price),
        ask: num(raw.ask1Price),
        mark: num(raw.markPrice),
        index: num(raw.indexPrice),

        // crowd/derivs
        funding: num(raw.fundingRate),
        openInterest: num(raw.openInterest),

        // 24h
        high24h: num(raw.highPrice24h),
        low24h: num(raw.lowPrice24h),
        volume24h: num(raw.volume24h),
        turnover24h: num(raw.turnover24h),

        // keep raw fields optionally if нужно дебажить
        // raw,
    };
}
