/**
 * The keyboard, as the chat screens and the file editor need it. Shared so the three screens
 * cannot drift (FileView's copy once read a stale bottom inset and never knew the keyboard
 * was up).
 *
 * Android fires no keyboardWill* events, only keyboardDid*. It also gets the keyboard's height
 * applied by hand (`androidKeyboard`), not by KeyboardAvoidingView: the app is edge-to-edge
 * (forced from Android 15), the window no longer resizes for the keyboard, and KAV's Android
 * arm left its padding behind after the keyboard closed (measured on a vivo X200 Pro, Android
 * 16), floating the composer over an empty band.
 */
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSplitBarSpace } from "../components/SplitFrame";

export interface KeyboardInset {
  /** the keyboard is showing (with it up there is no home indicator to clear) */
  keyboardUp: boolean;
  /** Android only: the padding that lifts content above the keys (0 on iOS, and when down) */
  androidKeyboard: number;
  /** iOS only: the keyboard's height, for a screen that pads by hand rather than with a KAV */
  iosKeyboard: number;
}

export function useKeyboardInset(): KeyboardInset {
  const insets = useSafeAreaInsets();
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  // In the split view a tab bar sits under the screen, so the screen ends that much above the
  // bottom edge and the keyboard covers that much less of it (its inset already reads 0 there).
  const barSpace = useSplitBarSpace();
  const barRef = useRef(barSpace);
  barRef.current = barSpace;
  const [state, setState] = useState<KeyboardInset>({ keyboardUp: false, androidKeyboard: 0, iosKeyboard: 0 });
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      const h = e.endCoordinates.height;
      setState({
        keyboardUp: true,
        // React Native reports the IME inset MINUS the navigation bar (ReactRootView:
        // ime.bottom - systemBars.bottom), but these screens run under the nav bar
        // (edge-to-edge), so content must clear both. Without the nav bar's share it sat one
        // nav-bar height too low, behind the keys (measured on the vivo, 3-button nav). Read
        // through a ref so a later inset change is never a stale closure.
        androidKeyboard: ios ? 0 : Math.max(0, h + insetsRef.current.bottom - barRef.current),
        iosKeyboard: ios ? Math.max(0, h - barRef.current) : 0,
      });
    });
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      setState({ keyboardUp: false, androidKeyboard: 0, iosKeyboard: 0 }),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return state;
}
