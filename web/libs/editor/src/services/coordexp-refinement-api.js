const JSON_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});

export class CoordExpHttpError extends Error {
  constructor(message, { code = "http_error", status = null, outcomeUnknown = false } = {}) {
    super(message);
    this.name = "CoordExpHttpError";
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

const parseResponse = async (response) => {
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new CoordExpHttpError("The refinement service returned invalid JSON.", {
        code: "invalid_json",
        status: response.status,
      });
    }
  }

  const resolvedError = payload?.error;

  if (!response.ok || resolvedError) {
    throw new CoordExpHttpError(
      resolvedError?.message || `The refinement request failed with HTTP ${response.status}.`,
      {
        code: resolvedError?.code || "http_error",
        status: response.status,
      },
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoordExpHttpError("The refinement service returned an empty response.", {
      code: "empty_response",
      status: response.status,
    });
  }

  return { payload, status: response.status };
};

export const createBatchId = (cryptoObject = globalThis.crypto) => {
  if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();
  if (typeof cryptoObject?.getRandomValues !== "function") {
    throw new Error("Secure UUID generation is unavailable in this browser.");
  }

  const bytes = cryptoObject.getRandomValues(new Uint8Array(16));

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export class CoordExpRefinementClient {
  constructor(projectId, fetchImpl) {
    if (!Number.isInteger(projectId) || projectId <= 0) throw new Error("A positive project ID is required.");
    const resolvedFetch = fetchImpl === undefined ? globalThis.fetch : fetchImpl;

    if (typeof resolvedFetch !== "function") throw new Error("A fetch implementation is required.");

    this.baseUrl = `/api/projects/${projectId}/coordexp-refinement`;
    this.fetch = fetchImpl === undefined ? resolvedFetch.bind(globalThis) : resolvedFetch;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });

    return parseResponse(response);
  }

  async session(signal) {
    const { payload } = await this.request("/session/", { method: "GET", signal });

    if (typeof payload.csrf_token !== "string" || !payload.csrf_token) {
      throw new CoordExpHttpError("The refinement session did not return a CSRF token.", {
        code: "missing_csrf_token",
      });
    }
    return payload;
  }

  async projectState(signal) {
    const { payload } = await this.request("/project-state/", { method: "GET", signal });

    return payload;
  }

  async status(batchId, signal) {
    const query = new URLSearchParams({ batch_id: batchId });
    const { payload } = await this.request(`/status/?${query}`, { method: "GET", signal });

    return payload;
  }

  async profiles(signal) {
    const { payload } = await this.request("/roi/profiles/", { method: "GET", signal });

    return payload;
  }

  async postWithCsrf(path, body, signal) {
    const session = await this.session(signal);
    try {
      return await this.request(path, {
        method: "POST",
        signal,
        headers: {
          ...JSON_HEADERS,
          "X-CSRFToken": session.csrf_token,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error?.name !== "AbortError" && (error?.status == null || (error.status >= 200 && error.status < 300))) {
        error.outcomeUnknown = true;
      }
      throw error;
    }
  }

  commit(batchId, signal) {
    return this.postWithCsrf("/commit/", { batch_id: batchId }, signal);
  }

  infer({ requestId, taskId, roi, resolution, profileSelector }, signal) {
    return this.postWithCsrf(
      "/roi/infer/",
      {
        request_id: requestId,
        task_id: taskId,
        roi: {
          x: roi?.x,
          y: roi?.y,
          width: roi?.width,
          height: roi?.height,
        },
        resolution: {
          width: resolution?.width,
          height: resolution?.height,
        },
        profile_selector: profileSelector,
      },
      signal,
    );
  }

  abandon({ receiptId, reason }, signal) {
    return this.postWithCsrf(
      "/roi/abandon/",
      {
        receipt_id: receiptId,
        reason,
      },
      signal,
    );
  }
}
