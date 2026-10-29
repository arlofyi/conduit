/** The real Keychain backend. Native module: never imported by anything under jest. */

import * as SecureStore from "expo-secure-store";
import type { KeyValueBackend } from "./macStore";
import { createMacStore } from "./macStore";

const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureBackend: KeyValueBackend = {
  get: (k) => SecureStore.getItemAsync(k, OPTS),
  set: (k, v) => SecureStore.setItemAsync(k, v, OPTS),
  del: (k) => SecureStore.deleteItemAsync(k, OPTS),
};

export const macStore = createMacStore(secureBackend);
