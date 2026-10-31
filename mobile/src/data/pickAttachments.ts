/**
 * The three ways to attach a file: the photo library, the camera, any document.
 *
 * Photos are re-encoded before upload (longest edge PHOTO_MAX_EDGE, JPEG 0.8): a 12 MP
 * phone photo drops from ~5 MB to ~400 KB, the agent gains nothing from the extra pixels,
 * and on cellular that is the difference between instant and a minute. Documents go as-is.
 * Android 13+ shows its own photo picker, which needs no storage permission.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, nameFor, PHOTO_MAX_EDGE } from "../logic/attachments";

/** `data` is the base64 body; empty with `tooBig` set when the file was never read
 * (over the limit: reading a 300 MB video into JS memory would crash the app first). */
export type Picked = { name: string; kind: "image" | "file"; uri: string; data: string; tooBig?: number };

async function shrink(asset: ImagePicker.ImagePickerAsset, n: number): Promise<Picked> {
  const { width, height } = asset;
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (Math.max(width, height) > PHOTO_MAX_EDGE) {
    ctx.resize(width >= height ? { width: PHOTO_MAX_EDGE } : { height: PHOTO_MAX_EDGE });
  }
  const image = await ctx.renderAsync();
  const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  return { name: nameFor(asset.fileName, "image", n, true), kind: "image", uri: out.uri, data: out.base64 ?? "" };
}

/** Pick up to `room` photos from the library. Empty when cancelled. */
export async function pickPhotos(room: number): Promise<Picked[]> {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: Math.max(1, Math.min(room, MAX_ATTACHMENTS)),
    quality: 1,
  });
  if (r.canceled) return [];
  return Promise.all(r.assets.slice(0, room).map((a, i) => shrink(a, i + 1)));
}

/** Take one photo. `null` when cancelled; throws when the camera permission is refused. */
export async function takePhoto(): Promise<Picked | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera access is off for Conduit. Turn it on in the phone's Settings.");
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  if (r.canceled || !r.assets[0]) return null;
  return shrink(r.assets[0], 1);
}

/** Pick up to `room` files of any type. Empty when cancelled. */
export async function pickFiles(room: number): Promise<Picked[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: room > 1, copyToCacheDirectory: true });
  if (r.canceled) return [];
  return Promise.all(
    r.assets.slice(0, room).map(async (a, i) => {
      const base = {
        name: nameFor(a.name, "file", i + 1, false),
        kind: (a.mimeType?.startsWith("image/") ? "image" : "file") as Picked["kind"],
        uri: a.uri,
      };
      const size = a.size ?? new File(a.uri).size;
      if (size > MAX_UPLOAD_BYTES) return { ...base, data: "", tooBig: size };
      return { ...base, data: await new File(a.uri).base64() };
    }),
  );
}
