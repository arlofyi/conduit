import {
  baseName,
  cacheName,
  canEdit,
  crumbs,
  entryDetail,
  fileKind,
  formatSize,
  fsErrorText,
  joinPath,
  languageOf,
  mimeOf,
  normPath,
  parentPath,
  sortEntries,
  splitLines,
  SECRET_PROMPT,
} from "./files";

describe("paths", () => {
  it("normalizes", () => {
    expect(normPath(" /a//b/ ")).toBe("a/b");
    expect(normPath("a\\b\\c")).toBe("a/b/c");
    expect(normPath("./a/./b")).toBe("a/b");
    expect(normPath("")).toBe("");
  });

  it("joins from the root and below", () => {
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("src", "app.ts")).toBe("src/app.ts");
    expect(joinPath("src/", "/app.ts")).toBe("src/app.ts");
    expect(joinPath("src", "")).toBe("src");
  });

  it("parent and base name", () => {
    expect(parentPath("src/logic/files.ts")).toBe("src/logic");
    expect(parentPath("README.md")).toBe("");
    expect(parentPath("")).toBe("");
    expect(baseName("src/logic/files.ts")).toBe("files.ts");
    expect(baseName("")).toBe("");
  });

  it("breadcrumb starts at the root and ends at the folder", () => {
    expect(crumbs("", "conduit")).toEqual([{ label: "conduit", path: "" }]);
    expect(crumbs("src/logic", "conduit")).toEqual([
      { label: "conduit", path: "" },
      { label: "src", path: "src" },
      { label: "logic", path: "src/logic" },
    ]);
  });
});

describe("listing", () => {
  it("folders first, then names ignoring case, numbers naturally", () => {
    const e = (name: string, dir = false) => ({ name, dir, size: 0, mtimeMs: 0 });
    const sorted = sortEntries([e("b.txt"), e("src", true), e("A.txt"), e("file10"), e("file2"), e("Docs", true)]);
    expect(sorted.map((x) => x.name)).toEqual(["Docs", "src", "A.txt", "b.txt", "file2", "file10"]);
  });

  it("sizes read like a file manager", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(812)).toBe("812 B");
    expect(formatSize(4300)).toBe("4.2 KB");
    expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatSize(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatSize(-1)).toBe("");
  });

  it("row detail", () => {
    expect(entryDetail({ name: "a", dir: false, size: 812, mtimeMs: 0 }, "Yesterday")).toBe("812 B · Yesterday");
    expect(entryDetail({ name: "a", dir: true, size: 0, mtimeMs: 0 }, "Yesterday")).toBe("Yesterday");
    expect(entryDetail({ name: "a", dir: false, size: 1, mtimeMs: 0, link: true }, "x")).toBe("Link");
  });
});

describe("file kinds", () => {
  it("by extension, case-insensitive", () => {
    expect(fileKind("shot.PNG")).toBe("image");
    expect(fileKind("a/b/photo.jpeg")).toBe("image");
    expect(fileKind("README.md")).toBe("markdown");
    expect(fileKind("notes.markdown")).toBe("markdown");
    expect(fileKind("logo.svg")).toBe("text");
    expect(fileKind("Makefile")).toBe("text");
    expect(fileKind(".png")).toBe("text"); // a dotfile, not an image
  });

  it("language guess", () => {
    expect(languageOf("src/app.tsx")).toBe("TypeScript (JSX)");
    expect(languageOf("lib.rs")).toBe("Rust");
    expect(languageOf("Dockerfile")).toBe("Dockerfile");
    expect(languageOf(".env.local")).toBe("Environment");
    expect(languageOf("data.bin")).toBeNull();
  });

  it("mime for the share sheet", () => {
    expect(mimeOf("a.png")).toBe("image/png");
    expect(mimeOf("a.pdf")).toBe("application/pdf");
    expect(mimeOf("a.ts")).toBe("text/plain");
    expect(mimeOf("a.bin")).toBe("application/octet-stream");
  });
});

describe("errors and editing", () => {
  it("words every refusal the computer sends", () => {
    expect(fsErrorText("confirm")).toBe(SECRET_PROMPT);
    expect(fsErrorText("conflict")).toMatch(/changed on your computer/);
    expect(fsErrorText("not found")).toMatch(/Not found/);
    expect(fsErrorText("private session")).toMatch(/private/);
    expect(fsErrorText("too many saves -- try again later")).toBe("Too many saves -- try again later");
    expect(fsErrorText("")).toBe("Something went wrong.");
    for (const e of ["not available", "read-only", "too large", "timeout", "not connected"]) {
      expect(fsErrorText(e)).not.toMatch(/Mac/);
    }
  });

  it("only a whole, writable, non-secret text file is editable", () => {
    const base = { binary: false, truncated: false, readOnly: false };
    expect(canEdit(base)).toBe(true);
    expect(canEdit({ ...base, binary: true })).toBe(false);
    expect(canEdit({ ...base, truncated: true })).toBe(false);
    expect(canEdit({ ...base, readOnly: true })).toBe(false);
    expect(canEdit({ ...base, sensitive: true })).toBe(false);
  });

  it("lines without a phantom last one", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("\n")).toEqual([""]);
  });

  it("cache names cannot escape the folder", () => {
    expect(cacheName("a/b/report.pdf")).toBe("report.pdf");
    expect(cacheName("..")).toBe("file");
    expect(cacheName('we:ird*"name')).toBe("we_ird__name");
    expect(cacheName("")).toBe("file");
  });
});
