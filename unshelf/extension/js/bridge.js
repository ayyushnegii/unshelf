export class BridgeError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

export class Bridge {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
  }

  async request(path, { method = "GET", body, timeout = 12000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Unshelf-Client": "extension",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // The bridge always returns JSON; a proxy or wrong port may not.
      }
      if (!response.ok) {
        throw new BridgeError(payload.error || `Bridge error ${response.status}`, response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.name === "AbortError") {
        throw new BridgeError("The local bridge did not answer in time.");
      }
      throw new BridgeError(
        "The local bridge is not running. Start it with start-unshelf.bat."
      );
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.request("/v1/health", { timeout: 3500 });
  }

  createJob(payload) {
    return this.request("/v1/jobs", { method: "POST", body: payload, timeout: 15000 });
  }

  getJob(id) {
    return this.request(`/v1/jobs/${encodeURIComponent(id)}`, { timeout: 8000 });
  }

  testKey(key) {
    return this.request("/v1/test-key", { method: "POST", body: { groqKey: key }, timeout: 12000 });
  }
}
