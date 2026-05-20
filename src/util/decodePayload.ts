export type PayloadEncoding = "base64" | "hex" | "utf8";

export function decodePayload(data: string, encoding: PayloadEncoding): Buffer {
  switch (encoding) {
    case "base64":
      return Buffer.from(data, "base64");
    case "hex":
      return Buffer.from(data.replace(/\s+/g, ""), "hex");
    case "utf8":
      return Buffer.from(data, "utf8");
  }
}
