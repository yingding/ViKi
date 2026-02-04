# Technical Insights: Real-Time Audio Streaming on Azure Functions

This document summarizes the technical challenges and architectural key learnings encountered during the implementation of the Virtual Clinic Voice Console.

## 1. The "Serverless Buffering" Trap

**The Problem:**
The most significant hurdle was implementing Server-Sent Events (SSE) on Azure Functions (Node.js v4 Model). By default, the Functions Host (and the underlying Kestrel server) buffers the response body. 
*   **Result:** The client would receive no data until the entire function execution finished or the connection closed. This completely broke the real-time requirement for SSE (where events must arrive immediately).
*   **Failed Attempts:** 
    *   We initially tried adding massive padding bytes (up to 2KB) to the start of the response to flush buffers (a common trick for Nginx/PHP), but this had no effect.
    *   We attempted to use `AsyncGenerator` functions (`async function*`), which are supported by Node.js, but the worker still buffered the yielded values.
    *   We tried manipulating headers like `X-Accel-Buffering` and `Cache-Control`, which helped with proxies but not the host itself.

**The Solution:**
The node.js v4 programming model has a specific, opt-in configuration required to enable true streaming:
```typescript
// src/index.ts
import { app } from '@azure/functions';
app.setup({ enableHttpStream: true }); // <--- CRITICAL
```
Without this flag, the worker communicates with the host via RPC in a way that often results in the response being treated as a single accumulated payload. Enabling this allows the `HttpResponseInit` body to be treated as a live stream.

## 2. Streaming Patterns: Generators vs. Direct Controllers

**Evolution:**
*   **Initial Approach:** Used Node.js `PassThrough` streams or `AsyncGenerators`. While "node-native", interfacing these with the Azure Functions response object while managing external events (like incoming audio from `SessionManager`) was complex. It required complex queueing logic (`chunkQueue`) and promise-based signal locks to bridge the gap between "pull-based" generators and "push-based" event listeners.
*   **Final Approach:** Switched to the **Web Streams API** (`ReadableStream`).
    ```typescript
    const stream = new ReadableStream({
        start(controller) {
            // Push-model: We can call controller.enqueue() whenever an event happens.
            // This maps perfectly to event-driven architectures (callbacks).
        }
    });
    ```
    This removed the need for the complex queueing/signaling logic. We simply pass the `controller` to our `SessionManager` or callback handlers, and they push data directly into the HTTP response stream.

## 3. Stateful "Serverless"

**The Challenge:**
HTTP is stateless, but a voice conversation is highly stateful. We needed to join two separate HTTP connections:
1.  `GET /voice-listen`: A long-lived SSE connection for **downlink** (server -> client audio/events).
2.  `POST /voice-send`: Short-lived requests for **uplink** (client -> server microphone data).

**The Solution:**
We implemented a Singleton `SessionManager` in memory.
*   The `listen` function creates a session and registers it in the map using the `consultId`.
*   The `send` function looks up the session by `consultId` to forward audio data.

**Risks:**
*   **Scaling:** This pattern currently relies on a single instance. If the Function App scales out to multiple instances, a request to `voice-send` might land on a server that doesn't accept the `voice-listen` connection, causing a "Session Not Found" error.
*   **Future Fix:** For production scale, this requires either "Sticky Sessions" (Session Affinity) or a durable state store (like Redis Pub/Sub) to bridge the instances.

## 4. Azure Functions Core Tools Quirks

**Build Locking:**
We observed "File does not exist" errors (Worker unable to load entry point) during development.
*   **Cause:** Running `npm run build` executes `rimraf dist`, deleting the code *while* the Azure Functions Host is actively polling/executing it.
*   **Workaround:** This is a race condition specific to local hot-reloading. Restarting the debug session or ensuring the build finishes before the next request resolves it.

## 5. Development Workflow Best Practice

For debugging streaming issues, `curl` proved superior to browser consoles. Browsers (Chrome/Edge) often buffer log output or handle SSE reconnection aggressively, masking the true network behavior. 
*   **Verified Command:** `curl -v -N http://localhost:7071/...`
    *   `-N` (no buffer) was essential to prove that the server was actually streaming and not just the client buffering.
