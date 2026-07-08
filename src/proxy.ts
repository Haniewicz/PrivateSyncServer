import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { config } from "./config.js";

const target = new URL(config.proxyTarget);
const proxy = http.createServer((request, response) => {
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request)
    },
    (upstreamResponse) => forwardResponse(upstreamResponse, response)
  );

  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad_gateway" }));
  });

  request.pipe(upstream);
});

proxy.on("upgrade", (request, socket, head) => {
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request)
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write("HTTP/" + upstreamResponse.httpVersion + " " + upstreamResponse.statusCode + " " + upstreamResponse.statusMessage + "\r\n");
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) socket.write(name + ": " + item + "\r\n");
      } else if (value !== undefined) {
        socket.write(name + ": " + value + "\r\n");
      }
    }
    socket.write("\r\n");
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstream.on("error", () => socket.destroy());
  upstream.end();
});

proxy.listen(config.proxyPort, config.proxyHost, () => {
  console.log("Private Sync proxy listening on " + config.proxyHost + ":" + config.proxyPort + ", forwarding to " + config.proxyTarget);
});

function forwardedHeaders(request: IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers };
  const remoteAddress = request.socket.remoteAddress ?? "";
  const existingForwardedFor = headerValue(headers["x-forwarded-for"]);
  headers["x-forwarded-for"] = existingForwardedFor ? existingForwardedFor + ", " + remoteAddress : remoteAddress;
  headers["x-forwarded-host"] = headerValue(request.headers.host) ?? config.proxyHost + ":" + config.proxyPort;
  headers["x-forwarded-proto"] = config.proxyProto;
  headers.host = target.host;
  return headers;
}

function forwardResponse(upstreamResponse: IncomingMessage, response: ServerResponse): void {
  response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
  upstreamResponse.pipe(response);
}

function headerValue(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "number") return String(value);
  return value;
}
