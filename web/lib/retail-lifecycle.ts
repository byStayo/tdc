export function retailFrameStatus(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  expectedSource: MessageEventSource | null,
): "ready" | "error" | null {
  if (!expectedSource || event.source !== expectedSource || event.origin !== "null") return null;
  const data: unknown = event.data;
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type !== "tdc-retail-frame" || message.version !== 1) return null;
  return message.status === "ready" || message.status === "error" ? message.status : null;
}
