import { canSendWith, chunkBase64, composeMessage, decodedBytes, formatBytes, MAX_UPLOAD_BYTES, nameFor, tooLarge, type Attachment } from "./attachments";

const ready = (path: string): Attachment => ({ id: path, name: path, kind: "image", uri: "", state: "ready", path });
const uploading: Attachment = { id: "u", name: "u", kind: "image", uri: "", state: "uploading" };
const failed: Attachment = { id: "f", name: "f", kind: "file", uri: "", state: "failed", error: "x" };

describe("composeMessage", () => {
  it("puts every uploaded file first, then the text", () => {
    expect(composeMessage("  what is this?  ", [ready(".conduit-uploads/a.jpg"), ready(".conduit-uploads/b.pdf")])).toBe(
      "@.conduit-uploads/a.jpg @.conduit-uploads/b.pdf what is this?",
    );
  });
  it("never ends on a bare @path, so Enter cannot pick an autocomplete", () => {
    expect(composeMessage("", [ready(".conduit-uploads/a.jpg")])).toBe("@.conduit-uploads/a.jpg ");
  });
  it("skips files that did not upload, and is plain text without files", () => {
    expect(composeMessage("hi", [uploading, failed])).toBe("hi");
    expect(composeMessage(" hi ", [])).toBe("hi");
  });
  it("quotes a path with a space", () => {
    expect(composeMessage("x", [ready(".conduit-uploads/a b.png")])).toBe('@".conduit-uploads/a b.png" x');
  });
});

describe("canSendWith", () => {
  it("needs text or a ready file, and waits for uploads", () => {
    expect(canSendWith("", [])).toBe(false);
    expect(canSendWith("hi", [])).toBe(true);
    expect(canSendWith("", [ready("p")])).toBe(true);
    expect(canSendWith("hi", [ready("p"), uploading])).toBe(false);
    expect(canSendWith("", [failed])).toBe(false);
  });
});

describe("chunkBase64", () => {
  it("splits on 4-character boundaries and keeps every byte", () => {
    const b64 = "QUJD".repeat(10) + "QQ==";
    const parts = chunkBase64(b64, 10);
    expect(parts.every((p, i) => i === parts.length - 1 || p.length % 4 === 0)).toBe(true);
    expect(parts.join("")).toBe(b64);
    expect(chunkBase64("")).toEqual([""]);
    expect(chunkBase64("QUJD", 1024)).toEqual(["QUJD"]);
  });
});

describe("sizes", () => {
  it("measures base64 without decoding", () => {
    expect(decodedBytes("aGk=")).toBe(2);
    expect(decodedBytes("aGVsbG8=")).toBe(5);
    expect(decodedBytes("YWJj")).toBe(3);
    expect(decodedBytes("")).toBe(0);
  });
  it("refuses what the Mac would refuse", () => {
    const limitB64Len = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
    expect(tooLarge("A".repeat(limitB64Len + 8))).toBe(true);
    expect(tooLarge("A".repeat(1024))).toBe(false);
  });
  it("formats sizes", () => {
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatBytes(10)).toBe("1 KB");
  });
});

describe("nameFor", () => {
  it("names unnamed assets and makes re-encoded photos .jpg", () => {
    expect(nameFor(null, "image", 2, true)).toBe("photo-2.jpg");
    expect(nameFor(undefined, "file", 1, false)).toBe("file-1");
    expect(nameFor("IMG_1.HEIC", "image", 1, true)).toBe("IMG_1.jpg");
    expect(nameFor("/storage/x/report.pdf", "file", 1, false)).toBe("report.pdf");
  });
});

describe("submitting a message with files", () => {
  it("holds the Enter only when the message names uploads", () => {
    const { submitDelayMs, promptInput, pasteInput } = require("../bridge/protocol");
    expect(submitDelayMs("plain text")).toBe(0);
    expect(submitDelayMs("@.conduit-uploads/a.jpg @.conduit-uploads/b.jpg Hello?")).toBe(1800);
    expect(promptInput("hi")).toBe(`${pasteInput("hi")}\r`);
  });
});
