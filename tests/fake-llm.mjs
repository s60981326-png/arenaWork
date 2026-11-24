// A tiny in-process OpenAI-compatible LLM stub used by the test suite.
//
// It streams SSE exactly like a real provider (data: {...}\n\n events, ending
// with data: [DONE]) and serves /v1/audio/transcriptions — the two endpoints
// ZENITH's backend talks to. No network, no keys, no real provider.

import http from "node:http";

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startFakeLlm({
  port = 0,
  host = "127.0.0.1",
  replyText = "Hello. I'm ZENITH — ready when you are.",
  memoryAck = true, // the model replies with a MEMORY suggestion line when asked to remember something
  rejectReasoningEffort = false, // simulate a provider that rejects the parameter
} = {}) {
  const state = {
    requests: [], // every chat request body we saw (for assertions)
    streamed: [], // text deltas we emitted
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
          return;
        }
        state.requests.push(body);

        if (rejectReasoningEffort && body.reasoning_effort) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unknown parameter: reasoning_effort" } }));
          return;
        }

        const wantsMemory = (body.messages || []).some((m) =>
          /remember/i.test(String(m.content || ""))
        );
        const text = wantsMemory && memoryAck
          ? `${replyText}\n\nMEMORY: remembers that the user likes morning routines`
          : replyText;

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const words = text.split(/(\s+)/);
        for (const word of words) {
          if (!word) continue;
          const chunk = {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model || "mock-model",
            choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
          };
          state.streamed.push(word);
          res.write(sseFrame(chunk));
        }
        res.write(
          sseFrame({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model || "mock-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })
        );
        res.end("data: [DONE]\n\n");
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
      // Drain the multipart body (we don't parse it — the fake doesn't need it).
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "mock transcript", language: "en" }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const { port: actual } = server.address();

  return {
    server,
    state,
    baseUrl: `http://${host}:${actual}/v1`,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
