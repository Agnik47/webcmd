import {
  BROWSER_RUN_PLAYWRIGHT_VERSION,
  BROWSER_RUN_PROTOCOL_VERSION,
} from './types.js';

/**
 * Playwright-compatible capability client that runs inside QuickJS.
 *
 * It intentionally contains no transport endpoint or Node integration. The
 * temporary host call is captured in a closure and removed before user source
 * runs; every reachable method maps to an allowlisted bridge operation.
 */
export const BROWSER_RUN_SANDBOX_CLIENT_SOURCE = `
(async () => {
  const hostCall = globalThis.__webcmdHostCall;
  if (typeof hostCall !== "function") {
    throw new Error("Browser-run host call is unavailable.");
  }

  const nativeConsole = globalThis.console;
  const configuredLogChars = Number(globalThis.__webcmdMaxLogChars);
  const maxLogChars = Number.isFinite(configuredLogChars) && configuredLogChars > 0
    ? Math.min(Math.floor(configuredLogChars), 65536)
    : 65536;
  if (!delete globalThis.__webcmdMaxLogChars) {
    globalThis.__webcmdMaxLogChars = undefined;
  }
  const boundedConsoleArgs = (args) => {
    const seen = new WeakSet();
    try {
      const serialized = JSON.stringify(args, (_key, value) => {
        const type = typeof value;
        if (type === "bigint") return String(value) + "n";
        if (type === "function" || type === "symbol") return "[" + type + "]";
        if (value && type === "object") {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        return value;
      }) || "[]";
      if (serialized.length > maxLogChars) {
        return [
          "[browser-run console truncated] "
          + serialized.slice(0, maxLogChars)
        ];
      }
      return JSON.parse(serialized);
    } catch {
      return ["[browser-run console value unavailable]"];
    }
  };
  const boundedConsole = Object.create(null);
  for (const level of ["log", "warn", "error", "info"]) {
    Object.defineProperty(boundedConsole, level, {
      value: (...args) => nativeConsole[level](...boundedConsoleArgs(args)),
      enumerable: true
    });
  }
  Object.freeze(boundedConsole);
  Object.defineProperty(globalThis, "console", {
    value: boundedConsole,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const base64Alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const encodeBase64 = (bytes) => {
    let result = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const chunk =
        (bytes[index] << 16)
        | ((bytes[index + 1] || 0) << 8)
        | (bytes[index + 2] || 0);
      result += base64Alphabet[(chunk >> 18) & 63];
      result += base64Alphabet[(chunk >> 12) & 63];
      result += index + 1 < bytes.length
        ? base64Alphabet[(chunk >> 6) & 63]
        : "=";
      result += index + 2 < bytes.length
        ? base64Alphabet[chunk & 63]
        : "=";
    }
    return result;
  };
  const decodeBase64 = (input) => {
    const value = String(input);
    if (
      value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
      throw new TypeError("Invalid base64 input.");
    }
    const output = [];
    for (let index = 0; index < value.length; index += 4) {
      const a = base64Alphabet.indexOf(value[index]);
      const b = base64Alphabet.indexOf(value[index + 1]);
      const c = value[index + 2] === "="
        ? 64
        : base64Alphabet.indexOf(value[index + 2]);
      const d = value[index + 3] === "="
        ? 64
        : base64Alphabet.indexOf(value[index + 3]);
      const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
      output.push((chunk >> 16) & 255);
      if (c !== 64) output.push((chunk >> 8) & 255);
      if (d !== 64) output.push(chunk & 255);
    }
    return new Uint8Array(output);
  };
  const encodeUtf8 = (input) => {
    const encoded = encodeURIComponent(String(input));
    const output = [];
    for (let index = 0; index < encoded.length; index += 1) {
      if (encoded[index] === "%") {
        output.push(parseInt(encoded.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        output.push(encoded.charCodeAt(index));
      }
    }
    return new Uint8Array(output);
  };
  const decodeUtf8 = (bytes) => {
    let encoded = "";
    for (const byte of bytes) {
      encoded += "%" + byte.toString(16).padStart(2, "0");
    }
    return decodeURIComponent(encoded);
  };

  class SandboxBuffer extends Uint8Array {
    static isBuffer(value) {
      return value instanceof SandboxBuffer;
    }

    static from(value, encoding) {
      if (typeof value === "string") {
        if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") {
          return new SandboxBuffer(encodeUtf8(value));
        }
        if (encoding === "base64") {
          return new SandboxBuffer(decodeBase64(value));
        }
        throw new TypeError("QuickJS Buffer supports only utf8 and base64 strings.");
      }
      if (value instanceof ArrayBuffer) {
        return new SandboxBuffer(value.slice(0));
      }
      if (ArrayBuffer.isView(value)) {
        return new SandboxBuffer(
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        );
      }
      if (Array.isArray(value)) {
        return new SandboxBuffer(value);
      }
      throw new TypeError("Unsupported Buffer.from input.");
    }

    toString(encoding) {
      if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") {
        return decodeUtf8(this);
      }
      if (encoding === "base64") {
        return encodeBase64(this);
      }
      throw new TypeError("QuickJS Buffer supports only utf8 and base64 output.");
    }
  }
  Object.freeze(SandboxBuffer.prototype);
  Object.freeze(SandboxBuffer);
  Object.defineProperty(globalThis, "Buffer", {
    value: SandboxBuffer,
    configurable: false,
    enumerable: true,
    writable: false
  });

  const encode = (value) => {
    if (value === undefined) return { $type: "Undefined" };
    if (value instanceof RegExp) {
      return { $type: "RegExp", source: value.source, flags: value.flags };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return {
        $type: "Bytes",
        encoding: "base64",
        data: encodeBase64(bytes)
      };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object") {
      const encoded = {};
      for (const key of Object.keys(value)) encoded[key] = encode(value[key]);
      return encoded;
    }
    return value;
  };
  const rpc = (operation, ...args) => (
    hostCall(operation, JSON.stringify(encode(args)))
  );
  await rpc("handshake", {
    protocolVersion: ${BROWSER_RUN_PROTOCOL_VERSION},
    playwrightVersion: ${JSON.stringify(BROWSER_RUN_PLAYWRIGHT_VERSION)}
  });
  const runCancellation = rpc("runtime.waitForCancellation");

  const remoteCache = new Map();
  const serializationError = () => {
    const error = new Error("Playwright remote objects cannot be returned from browser run.");
    error.code = "BROWSER_RUN_SERIALIZATION_ERROR";
    return error;
  };
  const unsupported = (name) => rpc("unsupported", name);
  const guardSurface = (target, surface) => {
    Object.freeze(target);
    return new Proxy(target, {
      get(object, property, receiver) {
        if (property === "then") return undefined;
        if (typeof property !== "string" || Reflect.has(object, property)) {
          return Reflect.get(object, property, receiver);
        }
        return () => unsupported(surface + "." + property);
      }
    });
  };
  const valueAndState = (result, state) => {
    if (result && result.state) Object.assign(state, result.state);
    return result ? result.value : undefined;
  };

  const locatorFrom = (originType, originHandle, pageState, frameState, recipe) => {
    const append = (method, args) => (
      locatorFrom(
        originType,
        originHandle,
        pageState,
        frameState,
        recipe.concat([{ method, args }])
      )
    );
    const call = async (method, args) => {
      const result = await rpc("locator.call", {
        originType,
        originHandle,
        recipe,
        method,
        args
      });
      if (result && result.pageState) Object.assign(pageState, result.pageState);
      if (result && result.frameState && frameState) {
        Object.assign(frameState, result.frameState);
      }
      return result ? result.value : undefined;
    };

    const locator = Object.create(null);
    const properties = {
      locator: (selector, options) => append("locator", [selector, options]),
      getByRole: (role, options) => append("getByRole", [role, options]),
      getByText: (text, options) => append("getByText", [text, options]),
      getByLabel: (text, options) => append("getByLabel", [text, options]),
      getByPlaceholder: (text, options) => append("getByPlaceholder", [text, options]),
      getByAltText: (text, options) => append("getByAltText", [text, options]),
      getByTitle: (text, options) => append("getByTitle", [text, options]),
      getByTestId: (id) => append("getByTestId", [id]),
      filter: (options) => {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("locator.filter() requires an options object.");
        }
        const encoded = { ...options };
        for (const key of ["has", "hasNot"]) {
          if (encoded[key] === undefined) continue;
          const nested = encoded[key];
          if (
            !nested
            || !nested.__recipe
            || nested.__originType !== originType
            || nested.__originHandle !== originHandle
          ) {
            throw new TypeError(
              "locator.filter(" + key + ") requires a locator from the same page or frame."
            );
          }
          encoded[key] = { $locatorRecipe: nested.__recipe };
        }
        return append("filter", [encoded]);
      },
      first: () => append("first", []),
      last: () => append("last", []),
      nth: (index) => append("nth", [index]),
      all: async () => {
        const length = await call("count", []);
        return Array.from({ length }, (_, index) => append("nth", [index]));
      },
      click: (options) => call("click", [options || {}]),
      dblclick: (options) => call("dblclick", [options || {}]),
      hover: (options) => call("hover", [options || {}]),
      focus: (options) => call("focus", [options || {}]),
      fill: (value, options) => call("fill", [value, options || {}]),
      press: (key, options) => call("press", [key, options || {}]),
      type: (value, options) => call("type", [value, options || {}]),
      clear: (options) => call("clear", [options || {}]),
      dispatchEvent: (type, eventInit) => (
        call("dispatchEvent", [type, eventInit || {}])
      ),
      selectOption: (value, options) => call("selectOption", [value, options || {}]),
      setChecked: (value, options) => call("setChecked", [value, options || {}]),
      check: (options) => call("setChecked", [true, options || {}]),
      uncheck: (options) => call("setChecked", [false, options || {}]),
      setInputFiles: (files, options) => (
        call("setInputFiles", [files, options || {}])
      ),
      dragTo: (target, options) => {
        if (!target || !target.__recipe) return unsupported("locator.dragTo");
        return call("dragTo", [target.__recipe, options || {}]);
      },
      screenshot: (options) => call("screenshot", [options || {}]),
      scrollIntoViewIfNeeded: (options) => (
        call("scrollIntoViewIfNeeded", [options || {}])
      ),
      textContent: (options) => call("textContent", [options || {}]),
      innerText: (options) => call("innerText", [options || {}]),
      innerHTML: (options) => call("innerHTML", [options || {}]),
      inputValue: (options) => call("inputValue", [options || {}]),
      getAttribute: (name, options) => (
        call("getAttribute", [name, options || {}])
      ),
      isVisible: (options) => call("isVisible", [options || {}]),
      isHidden: (options) => call("isHidden", [options || {}]),
      isEnabled: (options) => call("isEnabled", [options || {}]),
      isDisabled: (options) => call("isDisabled", [options || {}]),
      isEditable: (options) => call("isEditable", [options || {}]),
      isChecked: (options) => call("isChecked", [options || {}]),
      count: () => call("count", []),
      allInnerTexts: () => call("allInnerTexts", []),
      allTextContents: () => call("allTextContents", []),
      evaluate: (pageFunction, ...args) => call("evaluate", [{
        source: String(pageFunction),
        args
      }]),
      evaluateAll: (pageFunction, ...args) => call("evaluateAll", [{
        source: String(pageFunction),
        args
      }]),
      waitFor: (options) => call("waitFor", [options || {}]),
      toJSON: () => { throw serializationError(); }
    };
    for (const [name, value] of Object.entries(properties)) {
      Object.defineProperty(locator, name, {
        value,
        enumerable: name !== "toJSON"
      });
    }
    Object.defineProperty(locator, "__recipe", { value: recipe });
    Object.defineProperty(locator, "__originType", { value: originType });
    Object.defineProperty(locator, "__originHandle", { value: originHandle });
    return guardSurface(locator, "locator");
  };

  const locatorRoot = (type, handle, pageState, frameState, method, args) => (
    locatorFrom(type, handle, pageState, frameState, [{ method, args }])
  );

  const frameFrom = (descriptor, pageState) => {
    if (!descriptor || !descriptor.$remote || descriptor.$remote.type !== "frame") {
      throw new Error("Browser-run bridge returned an invalid frame descriptor.");
    }
    const { handle, state = {} } = descriptor.$remote;
    const cached = remoteCache.get(handle);
    if (cached) {
      Object.assign(cached.__state, state);
      return cached.value;
    }
    const frameState = { ...state };
    const call = async (method, args) => (
      valueAndState(await rpc("frame.call", { handle, method, args }), frameState)
    );
    const frame = Object.create(null);
    const properties = {
      name: () => String(frameState.name || ""),
      url: () => String(frameState.url || ""),
      locator: (selector, options) => (
        locatorRoot("frame", handle, pageState, frameState, "locator", [selector, options])
      ),
      getByRole: (role, options) => (
        locatorRoot("frame", handle, pageState, frameState, "getByRole", [role, options])
      ),
      getByText: (text, options) => (
        locatorRoot("frame", handle, pageState, frameState, "getByText", [text, options])
      ),
      getByLabel: (text, options) => (
        locatorRoot("frame", handle, pageState, frameState, "getByLabel", [text, options])
      ),
      getByPlaceholder: (text, options) => (
        locatorRoot("frame", handle, pageState, frameState, "getByPlaceholder", [text, options])
      ),
      getByAltText: (text, options) => (
        locatorRoot("frame", handle, pageState, frameState, "getByAltText", [text, options])
      ),
      getByTitle: (text, options) => (
        locatorRoot("frame", handle, pageState, frameState, "getByTitle", [text, options])
      ),
      getByTestId: (id) => (
        locatorRoot("frame", handle, pageState, frameState, "getByTestId", [id])
      ),
      evaluate: (pageFunction, ...args) => call("evaluate", [{
        source: String(pageFunction),
        args
      }]),
      content: () => call("content", []),
      waitForLoadState: (state, options) => (
        call("waitForLoadState", [state, options || {}])
      ),
      waitForURL: (url, options) => call("waitForURL", [url, options || {}]),
      waitForSelector: async (selector, options) => {
        const target = locatorRoot(
          "frame",
          handle,
          pageState,
          frameState,
          "locator",
          [selector, undefined]
        );
        await target.waitFor(options || {});
        return target;
      },
      toJSON: () => { throw serializationError(); }
    };
    for (const [name, value] of Object.entries(properties)) {
      Object.defineProperty(frame, name, {
        value,
        enumerable: name !== "toJSON"
      });
    }
    const guardedFrame = guardSurface(frame, "frame");
    remoteCache.set(handle, { value: guardedFrame, __state: frameState });
    return guardedFrame;
  };

  const requestFrom = (descriptor) => {
    if (!descriptor || !descriptor.$remote || descriptor.$remote.type !== "request") {
      throw new Error("Browser-run bridge returned an invalid request descriptor.");
    }
    const { handle, state = {} } = descriptor.$remote;
    const cached = remoteCache.get(handle);
    if (cached) {
      Object.assign(cached.__state, state);
      return cached.value;
    }
    const requestState = { ...state };
    const request = Object.create(null);
    const properties = {
      url: () => String(requestState.url || ""),
      method: () => String(requestState.method || ""),
      resourceType: () => String(requestState.resourceType || ""),
      headers: () => ({ ...(requestState.headers || {}) }),
      allHeaders: () => rpc("request.call", { handle, method: "allHeaders", args: [] }),
      postData: () => requestState.postData == null ? null : String(requestState.postData),
      failure: () => requestState.failure == null ? null : requestState.failure,
      toJSON: () => { throw serializationError(); }
    };
    for (const [name, value] of Object.entries(properties)) {
      Object.defineProperty(request, name, {
        value,
        enumerable: name !== "toJSON"
      });
    }
    Object.freeze(request);
    remoteCache.set(handle, { value: request, __state: requestState });
    return request;
  };

  const responseFrom = (descriptor) => {
    if (!descriptor || !descriptor.$remote || descriptor.$remote.type !== "response") {
      throw new Error("Browser-run bridge returned an invalid response descriptor.");
    }
    const { handle, state = {} } = descriptor.$remote;
    const cached = remoteCache.get(handle);
    if (cached) {
      Object.assign(cached.__state, state);
      return cached.value;
    }
    const responseState = { ...state };
    const response = Object.create(null);
    const properties = {
      url: () => String(responseState.url || ""),
      status: () => Number(responseState.status || 0),
      ok: () => Boolean(responseState.ok),
      headers: () => ({ ...(responseState.headers || {}) }),
      allHeaders: () => rpc("response.call", { handle, method: "allHeaders", args: [] }),
      request: () => requestFrom(responseState.request),
      body: async () => new Uint8Array(
        await rpc("response.call", { handle, method: "body", args: [] })
      ),
      text: () => rpc("response.call", { handle, method: "text", args: [] }),
      json: () => rpc("response.call", { handle, method: "json", args: [] }),
      toJSON: () => { throw serializationError(); }
    };
    for (const [name, value] of Object.entries(properties)) {
      Object.defineProperty(response, name, {
        value,
        enumerable: name !== "toJSON"
      });
    }
    Object.freeze(response);
    remoteCache.set(handle, { value: response, __state: responseState });
    return response;
  };

  const networkValueFrom = (event, descriptor) => (
    event === "request" ? requestFrom(descriptor) : responseFrom(descriptor)
  );
  const networkMatches = async (value, predicate) => {
    if (typeof predicate === "function") return Boolean(await predicate(value));
    if (predicate instanceof RegExp) return predicate.test(value.url());
    if (typeof predicate === "string") return value.url().includes(predicate);
    throw new TypeError("Network predicate must be a function, RegExp, or string.");
  };
  const waitForNetwork = async (pageHandle, event, predicate, options) => {
    const id = await rpc("network.start", { pageHandle, event });
    let timeoutId;
    try {
      const loop = async () => {
        while (true) {
          const descriptor = await rpc("network.next", { id });
          const value = networkValueFrom(event, descriptor);
          if (await networkMatches(value, predicate)) return value;
        }
      };
      const timeout = options && Number(options.timeout);
      if (!(timeout > 0)) return await loop();
      return await Promise.race([
        loop(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error(
              "Timed out waiting for browser-run " + event + " event."
            );
            error.code = "BROWSER_RUN_TIMEOUT";
            reject(error);
          }, timeout);
        })
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      await rpc("network.stop", { id });
    }
  };

  const pageFrom = (descriptor) => {
    if (!descriptor || !descriptor.$remote || descriptor.$remote.type !== "page") {
      throw new Error("Browser-run bridge returned an invalid page descriptor.");
    }
    const { handle, state = {} } = descriptor.$remote;
    const cached = remoteCache.get(handle);
    if (cached) {
      Object.assign(cached.__state, state);
      return cached.value;
    }

    const pageState = { ...state };
    let guardedPage;
    const call = async (method, args) => (
      valueAndState(await rpc("page.call", { handle, method, args }), pageState)
    );
    const eventListeners = new Map();
    const on = (event, listener) => {
      if ((event !== "request" && event !== "response") || typeof listener !== "function") {
        return unsupported("page.on(" + String(event) + ")");
      }
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Map();
        eventListeners.set(event, listeners);
      }
      if (listeners.has(listener)) return guardedPage;
      const control = { stopped: false, id: undefined };
      listeners.set(listener, control);
      (async () => {
        try {
          control.id = await rpc("network.start", { pageHandle: handle, event });
          while (!control.stopped) {
            const descriptor = await rpc("network.next", { id: control.id });
            if (!control.stopped) {
              await listener(networkValueFrom(event, descriptor));
            }
          }
        } catch (error) {
          if (
            !control.stopped
            && (!error || error.code !== "BROWSER_RUN_CANCELLED")
          ) {
            console.error(error);
          }
        } finally {
          if (control.id !== undefined) {
            await rpc("network.stop", { id: control.id });
          }
        }
      })();
      return guardedPage;
    };
    const off = (event, listener) => {
      const listeners = eventListeners.get(event);
      const control = listeners && listeners.get(listener);
      if (control) {
        control.stopped = true;
        listeners.delete(listener);
        if (control.id !== undefined) {
          rpc("network.stop", { id: control.id });
        }
      }
      return guardedPage;
    };
    const page = Object.create(null);
    const properties = {
      url: () => String(pageState.url || ""),
      title: () => call("title", []),
      content: () => call("content", []),
      goto: (url, options) => call("goto", [url, options || {}]),
      reload: (options) => call("reload", [options || {}]),
      goBack: (options) => call("goBack", [options || {}]),
      goForward: (options) => call("goForward", [options || {}]),
      waitForLoadState: (state, options) => (
        call("waitForLoadState", [state, options || {}])
      ),
      waitForURL: (url, options) => call("waitForURL", [url, options || {}]),
      waitForTimeout: (timeout) => new Promise((resolve) => {
        setTimeout(resolve, Number(timeout));
      }),
      evaluate: (pageFunction, ...args) => call("evaluate", [{
        source: String(pageFunction),
        args
      }]),
      waitForSelector: async (selector, options) => {
        const target = locatorRoot(
          "page",
          handle,
          pageState,
          null,
          "locator",
          [selector, undefined]
        );
        await target.waitFor(options || {});
        return target;
      },
      frames: () => (pageState.frames || []).map((item) => frameFrom(item, pageState)),
      waitForEvent: async (name, options) => {
        const result = await call("waitForEvent", [name, options || {}]);
        return pageFrom(result);
      },
      screenshot: (options) => call("screenshot", [options || {}]),
      waitForRequest: (predicate, options) => (
        waitForNetwork(handle, "request", predicate, options || {})
      ),
      waitForResponse: (predicate, options) => (
        waitForNetwork(handle, "response", predicate, options || {})
      ),
      on,
      off,
      locator: (selector, options) => (
        locatorRoot("page", handle, pageState, null, "locator", [selector, options])
      ),
      getByRole: (role, options) => (
        locatorRoot("page", handle, pageState, null, "getByRole", [role, options])
      ),
      getByText: (text, options) => (
        locatorRoot("page", handle, pageState, null, "getByText", [text, options])
      ),
      getByLabel: (text, options) => (
        locatorRoot("page", handle, pageState, null, "getByLabel", [text, options])
      ),
      getByPlaceholder: (text, options) => (
        locatorRoot("page", handle, pageState, null, "getByPlaceholder", [text, options])
      ),
      getByAltText: (text, options) => (
        locatorRoot("page", handle, pageState, null, "getByAltText", [text, options])
      ),
      getByTitle: (text, options) => (
        locatorRoot("page", handle, pageState, null, "getByTitle", [text, options])
      ),
      getByTestId: (id) => (
        locatorRoot("page", handle, pageState, null, "getByTestId", [id])
      ),
      context: () => unsupported("page.context"),
      toJSON: () => { throw serializationError(); }
    };
    for (const [name, value] of Object.entries(properties)) {
      Object.defineProperty(page, name, {
        value,
        enumerable: name !== "toJSON"
      });
    }
    guardedPage = guardSurface(page, "page");
    remoteCache.set(handle, { value: guardedPage, __state: pageState });
    return guardedPage;
  };

  const browserApi = Object.create(null);
  Object.defineProperties(browserApi, {
    currentPage: {
      value: async () => pageFrom(await rpc("browser.currentPage")),
      enumerable: true
    },
    getPage: {
      value: async (nameOrId) => pageFrom(await rpc("browser.getPage", nameOrId)),
      enumerable: true
    },
    pages: {
      value: async () => {
        const pages = await rpc("browser.pages");
        return pages.map(pageFrom);
      },
      enumerable: true
    }
  });
  Object.freeze(browserApi);

  if (!delete globalThis.__webcmdHostCall) {
    globalThis.__webcmdHostCall = undefined;
  }
  const serializeResult = (input) => {
    const seen = new WeakSet();
    try {
      const json = JSON.stringify(input === undefined ? null : input, (_key, value) => {
        const type = typeof value;
        if (type === "function" || type === "symbol" || type === "bigint") {
          throw new TypeError("Browser-run results must contain only JSON-compatible values.");
        }
        if (value && type === "object") {
          if (seen.has(value)) {
            throw new TypeError("Browser-run results cannot contain circular references.");
          }
          seen.add(value);
        }
        return value === undefined ? null : value;
      });
      return json === undefined ? "null" : json;
    } catch (cause) {
      if (cause && cause.code === "BROWSER_RUN_SERIALIZATION_ERROR") throw cause;
      const error = new Error(cause && cause.message
        ? cause.message
        : "Browser-run result is not serializable.");
      error.code = "BROWSER_RUN_SERIALIZATION_ERROR";
      throw error;
    }
  };
  Object.defineProperty(globalThis, "__webcmdSerializeResult", {
    value: serializeResult,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(globalThis, "__webcmdRaceRun", {
    value: (program) => Promise.race([
      Promise.resolve().then(program),
      runCancellation
    ]),
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(globalThis, "browser", {
    value: browserApi,
    configurable: false,
    enumerable: true,
    writable: false
  });
  Object.defineProperty(globalThis, "page", {
    value: await browserApi.currentPage(),
    configurable: false,
    enumerable: true,
    writable: false
  });
})()
`;
