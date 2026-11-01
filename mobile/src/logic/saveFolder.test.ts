import { folderLabel, isPickerCancel } from "./saveFolder";

describe("folderLabel", () => {
  it("names the last folder of a SAF tree URI", () => {
    expect(folderLabel("content://com.android.externalstorage.documents/tree/primary%3ADownload")).toBe("Download");
    expect(folderLabel("content://com.android.externalstorage.documents/tree/primary%3ADownload%2FConduit")).toBe("Conduit");
    expect(folderLabel("content://com.android.externalstorage.documents/tree/primary%3ADocuments%2F")).toBe("Documents");
  });
  it("a volume root reads as the volume", () => {
    expect(folderLabel("content://com.android.externalstorage.documents/tree/primary%3A")).toBe("Internal storage");
    expect(folderLabel("content://com.android.externalstorage.documents/tree/1A2B-3C4D%3A")).toBe("1A2B-3C4D");
  });
  it("anything else is described, never shown raw", () => {
    expect(folderLabel(null)).toBe("the folder you picked");
    expect(folderLabel("file:///data/user/0/x/cache/")).toBe("the folder you picked");
    expect(folderLabel("content://x/tree/%E0%A4%A")).toBe("the folder you picked");
  });
});

describe("isPickerCancel", () => {
  it("recognises the picker's cancel", () => {
    expect(isPickerCancel({ code: "ERR_PICKER_CANCELLED", message: "The file picker was cancelled by the user" })).toBe(true);
    expect(isPickerCancel(new Error("The file picker was cancelled by the user"))).toBe(true);
    expect(isPickerCancel(new Error("Permission denied"))).toBe(false);
    expect(isPickerCancel(null)).toBe(false);
  });
});
